import { loadConfig, loadDotEnvFile } from "./config";
import { createGatewayApp } from "./app";
import { FileBackedQueueStore } from "./local_queue_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { OutboundNotificationStore } from "./notification_store";
import { startNotificationDispatcher } from "./notification_dispatcher";
import { StdoutWhatsAppAdapter } from "../../../packages/provider-adapters/src";
import { MemoryService } from "../../../packages/memory/src";
import { ReminderStore } from "./builtins/reminder_store";
import { NoteStore } from "./builtins/note_store";
import { TaskStore } from "./builtins/task_store";
import { ApprovalStore } from "./builtins/approval_store";
import { startReminderDispatcher } from "./builtins/reminder_dispatcher";
import { OAuthService } from "./auth/oauth_service";
import { OpenAIResponsesService } from "./llm/openai_responses_service";
import { CodexAppServerClient } from "./codex/app_server_client";
import { CodexAuthService } from "./codex/auth_service";
import { CodexThreadStore } from "./codex/thread_store";
import { CodexChatService } from "./llm/codex_chat_service";
import { HybridLlmService } from "./llm/hybrid_llm_service";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const dedupeStore = new MessageDedupeStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const reminderStore = new ReminderStore(config.stateDir);
  const noteStore = new NoteStore(config.stateDir);
  const taskStore = new TaskStore(config.stateDir);
  const approvalStore = new ApprovalStore(config.stateDir);
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
  let codexClient: CodexAppServerClient | undefined;
  let codexAuthService: CodexAuthService | undefined;
  let codexChatService: CodexChatService | undefined;

  if (config.codexAppServerEnabled) {
    codexClient = new CodexAppServerClient({
      command: config.codexAppServerCommand,
      clientName: config.codexAppServerClientName,
      clientVersion: config.codexAppServerClientVersion
    });
    codexAuthService = new CodexAuthService(codexClient);
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

  let llmService: HybridLlmService;
  const memoryService = new MemoryService({
    rootDir: process.cwd(),
    stateDir: config.stateDir
  });

  await store.ensureReady();
  await dedupeStore.ensureReady();
  await notificationStore.ensureReady();
  await reminderStore.ensureReady();
  await noteStore.ensureReady();
  await taskStore.ensureReady();
  await approvalStore.ensureReady();
  await oauthService.ensureReady();
  if (codexAuthService) {
    try {
      await codexAuthService.ensureReady();
    } catch {
      // Codex auth remains disabled if startup fails; Responses fallback still works.
      await codexAuthService.stop();
      codexAuthService = undefined;
      codexChatService = undefined;
    }
  }
  await memoryService.start();

  llmService = new HybridLlmService({
    codex: codexChatService,
    responses: responsesService
  });

  const app = createGatewayApp(store, {
    dedupeStore,
    notificationStore,
    memoryService,
    reminderStore,
    noteStore,
    taskStore,
    approvalStore,
    oauthService,
    llmService,
    codexAuthService,
    codexLoginMode: config.codexAuthLoginMode,
    codexApiKey: config.openAiApiKey
  });
  const adapter = new StdoutWhatsAppAdapter();
  const dispatcher = startNotificationDispatcher({
    store: notificationStore,
    adapter,
    pollIntervalMs: config.notificationPollMs
  });
  const reminderDispatcher = startReminderDispatcher({
    reminderStore,
    notificationStore,
    pollIntervalMs: config.reminderPollMs
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] listening on :${config.port} using state dir ${config.stateDir}`);
  });

  const shutdown = async () => {
    await dispatcher.stop();
    await reminderDispatcher.stop();
    await memoryService.stop();
    if (codexAuthService) {
      await codexAuthService.stop();
    }
    server.close();
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
