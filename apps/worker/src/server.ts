import { loadConfig, loadDotEnvFile } from "../../gateway-orchestrator/src/config";
import { FileBackedQueueStore } from "../../gateway-orchestrator/src/local_queue_store";
import { OutboundNotificationStore } from "../../gateway-orchestrator/src/notification_store";
import { OAuthService } from "../../gateway-orchestrator/src/auth/oauth_service";
import { OpenAIResponsesService } from "../../gateway-orchestrator/src/llm/openai_responses_service";
import { HybridLlmService } from "../../gateway-orchestrator/src/llm/hybrid_llm_service";
import { WebSearchService } from "../../gateway-orchestrator/src/builtins/web_search_service";
import { CodexAppServerClient } from "../../gateway-orchestrator/src/codex/app_server_client";
import { CodexAuthStateStore } from "../../gateway-orchestrator/src/codex/auth_state_store";
import { CodexAuthService } from "../../gateway-orchestrator/src/codex/auth_service";
import { CodexThreadStore } from "../../gateway-orchestrator/src/codex/thread_store";
import { CodexChatService } from "../../gateway-orchestrator/src/llm/codex_chat_service";
import { PagedResponseStore } from "../../gateway-orchestrator/src/builtins/paged_response_store";
import { SupervisorStore } from "../../gateway-orchestrator/src/builtins/supervisor_store";
import { RunSpecStore } from "../../gateway-orchestrator/src/builtins/run_spec_store";
import { startWorker } from "./worker";
import { createWorkerProcessor } from "./execution/processor";
import { createWorkerStatusHandler } from "./execution/status_handler";
import { ensureWorkerCodexRuntime } from "./runtime/codex_runtime";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const pagedResponseStore = new PagedResponseStore(config.stateDir);
  const supervisorStore = new SupervisorStore(config.stateDir);
  const runSpecStore = new RunSpecStore(config.stateDir);
  const oauthService = new OAuthService({
    stateDir: config.stateDir,
    publicBaseUrl: config.publicBaseUrl,
    encryptionKey: config.oauthTokenEncryptionKey,
    stateTtlMs: config.oauthStateTtlMs,
    openai: {
      mode: config.oauthOpenAiMode,
      clientId: config.oauthOpenAiClientId,
      clientSecret: config.oauthOpenAiClientSecret,
      authorizeUrl: config.oauthOpenAiAuthorizeUrl,
      tokenUrl: config.oauthOpenAiTokenUrl,
      scope: config.oauthOpenAiScope
    }
  });
  const responsesService = new OpenAIResponsesService({
    enabled: config.openAiResponsesEnabled,
    apiUrl: config.openAiResponsesUrl,
    model: config.openAiResponsesModel,
    timeoutMs: config.openAiResponsesTimeoutMs,
    apiKey: config.openAiApiKey,
    oauthService
  });

  let codexAuthService: CodexAuthService | undefined;
  let codexChatService: CodexChatService | undefined;
  if (config.codexAppServerEnabled) {
    const codexClient = new CodexAppServerClient({
      command: config.codexAppServerCommand,
      clientName: `${config.codexAppServerClientName}-worker`,
      clientVersion: config.codexAppServerClientVersion
    });
    const authStateStore = new CodexAuthStateStore(config.stateDir);
    codexAuthService = new CodexAuthService(codexClient, { stateStore: authStateStore });
    const threadStore = new CodexThreadStore(config.stateDir);
    codexChatService = new CodexChatService({
      client: codexClient,
      auth: codexAuthService,
      threadStore,
      model: config.codexModel,
      timeoutMs: config.codexTurnTimeoutMs,
      accountRefreshBeforeTurn: config.codexAccountRefreshBeforeTurn
    });
  }

  await store.ensureReady();
  await notificationStore.ensureReady();
  await pagedResponseStore.ensureReady();
  await supervisorStore.ensureReady();
  await runSpecStore.ensureReady();
  await oauthService.ensureReady();
  const ensuredCodex = await ensureWorkerCodexRuntime({
    auth: codexAuthService,
    chat: codexChatService
  });
  codexAuthService = ensuredCodex.auth;
  codexChatService = ensuredCodex.chat;

  const llmService = new HybridLlmService({
    codex: codexChatService,
    responses: responsesService
  });
  const webSearchService = new WebSearchService({
    defaultProvider: config.alfredWebSearchProvider,
    llmService,
    brave: {
      apiKey: config.braveSearchApiKey,
      url: config.braveSearchUrl,
      timeoutMs: config.braveSearchTimeoutMs,
      maxResults: config.braveSearchMaxResults
    },
    searxng: {
      url: config.searxngSearchUrl,
      timeoutMs: config.searxngSearchTimeoutMs,
      maxResults: config.searxngSearchMaxResults,
      language: config.searxngSearchLanguage,
      safeSearch: config.searxngSearchSafeSearch
    },
    brightdata: {
      apiKey: config.brightDataApiKey,
      serpUrl: config.brightDataSerpUrl,
      zone: config.brightDataZone,
      timeoutMs: config.brightDataTimeoutMs,
      maxResults: config.brightDataMaxResults
    },
    perplexity: {
      apiKey: config.perplexityApiKey,
      url: config.perplexitySearchUrl,
      model: config.perplexityModel,
      timeoutMs: config.perplexityTimeoutMs
    }
  });
  const processor = createWorkerProcessor({
    config: {
      alfredWorkspaceDir: config.alfredWorkspaceDir,
      alfredWebSearchProvider: config.alfredWebSearchProvider
    },
    webSearchService,
    llmService,
    pagedResponseStore,
    notificationStore,
    runSpecStore
  });
  const onStatusChange = createWorkerStatusHandler({
    notificationStore,
    store,
    supervisorStore
  });

  const handles = Array.from({ length: config.workerConcurrency }, (_, index) =>
    startWorker({
      store,
      pollIntervalMs: config.workerPollMs,
      workerId: `worker-main-${index + 1}`,
      processor,
      onStatusChange
    })
  );

  // eslint-disable-next-line no-console
  console.log(`[worker] running with poll interval ${config.workerPollMs}ms and concurrency ${config.workerConcurrency}`);

  const shutdown = async () => {
    await Promise.all(handles.map((handle) => handle.stop()));
    if (codexAuthService) {
      await codexAuthService.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
