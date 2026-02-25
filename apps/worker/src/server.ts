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
import { startWorker } from "./worker";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const pagedResponseStore = new PagedResponseStore(config.stateDir);
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
    perplexity: {
      apiKey: config.perplexityApiKey,
      url: config.perplexitySearchUrl,
      model: config.perplexityModel,
      timeoutMs: config.perplexityTimeoutMs
    }
  });

  await store.ensureReady();
  await notificationStore.ensureReady();
  await pagedResponseStore.ensureReady();
  await oauthService.ensureReady();
  if (codexAuthService) {
    try {
      await codexAuthService.ensureReady();
    } catch {
      await codexAuthService.stop();
      codexAuthService = undefined;
      codexChatService = undefined;
    }
  }
  const jobNotificationState = new Map<string, { lastProgressAt: number; lastProgressText: string }>();

  const handle = startWorker({
    store,
    pollIntervalMs: config.workerPollMs,
    workerId: "worker-main",
    processor: async (job, context) => {
      const taskType = String(job.payload.taskType ?? "").trim().toLowerCase();
      if (taskType !== "web_search") {
        const action = String(job.payload.action ?? job.payload.text ?? job.type);
        return {
          summary: `processed:${action}`,
          processedAt: new Date().toISOString()
        };
      }

      const sessionId = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
      const query = String(job.payload.query ?? "").trim();
      const authSessionId =
        typeof job.payload.authSessionId === "string" && job.payload.authSessionId.trim()
          ? job.payload.authSessionId.trim()
          : sessionId;
      const authPreference = normalizeAuthPreference(job.payload.authPreference);
      const provider = normalizeWebSearchProvider(job.payload.provider) ?? config.alfredWebSearchProvider;

      if (!query) {
        return {
          summary: "web_search_missing_query",
          responseText: "Web search task failed: missing query."
        };
      }

      await context.reportProgress({
        step: "queued",
        message: `Starting web search for: ${query.slice(0, 140)}`
      });
      await context.reportProgress({
        step: "searching",
        message: `Searching via ${provider}...`
      });
      const result = await webSearchService.search(query, {
        provider,
        authSessionId,
        authPreference
      });
      if (!result?.text?.trim()) {
        return {
          summary: "web_search_no_results",
          responseText: "No web search result is available for this query."
        };
      }

      await context.reportProgress({
        step: "synthesizing",
        message: "Formatting final response..."
      });
      const fullText = `Web search provider: ${result.provider}\n${result.text.trim()}`;
      const pages = paginateResponse(fullText, 1400, 8);
      const firstPage = pages[0] ?? fullText;
      if (sessionId && pages.length > 1) {
        await pagedResponseStore.setPages(sessionId, pages.slice(1));
      } else if (sessionId) {
        await pagedResponseStore.clear(sessionId);
      }

      const responseText =
        pages.length > 1 ? `${firstPage}\n\nReply #next for more (${pages.length - 1} remaining).` : firstPage;

      return {
        summary: `web_search_${result.provider}`,
        responseText,
        provider: result.provider,
        pageCount: pages.length
      };
    },
    onStatusChange: async (event) => {
      if (!event.sessionId) {
        return;
      }

      const summary = event.summary ? ` (${event.summary})` : "";
      const status = event.status === "progress" ? "running" : event.status;
      const now = Date.now();
      const notifyState = jobNotificationState.get(event.jobId) ?? { lastProgressAt: 0, lastProgressText: "" };

      let text: string | null = null;
      if (event.status === "running") {
        text = `Working on job ${event.jobId}...`;
      } else if (event.status === "progress") {
        const nextText = String(event.summary ?? "still working");
        const shouldSend =
          now - notifyState.lastProgressAt >= 45_000 && nextText.trim() && nextText !== notifyState.lastProgressText;
        if (shouldSend) {
          text = `Still working on job ${event.jobId}: ${nextText}`;
          notifyState.lastProgressAt = now;
          notifyState.lastProgressText = nextText;
          jobNotificationState.set(event.jobId, notifyState);
        }
      } else if (event.status === "succeeded" && event.responseText) {
        text = event.responseText;
      } else {
        text = `Job ${event.jobId} is ${event.status}${summary}`;
      }

      if (!text) {
        return;
      }

      await notificationStore.enqueue({
        sessionId: event.sessionId,
        jobId: event.jobId,
        status,
        text
      });

      if (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") {
        jobNotificationState.delete(event.jobId);
      }
    }
  });

  // eslint-disable-next-line no-console
  console.log(`[worker] running with poll interval ${config.workerPollMs}ms`);

  const shutdown = async () => {
    await handle.stop();
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

function normalizeAuthPreference(raw: unknown): "auto" | "oauth" | "api_key" {
  if (typeof raw !== "string") {
    return "auto";
  }
  const value = raw.trim().toLowerCase();
  if (value === "oauth") {
    return "oauth";
  }
  if (value === "api_key") {
    return "api_key";
  }
  return "auto";
}

function normalizeWebSearchProvider(raw: unknown): "openai" | "brave" | "perplexity" | "auto" | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "openai" || value === "brave" || value === "perplexity" || value === "auto") {
    return value;
  }
  return null;
}

function paginateResponse(text: string, maxCharsPerPage: number, maxPages: number): string[] {
  const compact = text.trim();
  if (!compact) {
    return [];
  }
  if (compact.length <= maxCharsPerPage) {
    return [compact];
  }

  const paragraphs = compact
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const pages: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (!value) {
      return;
    }
    pages.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharsPerPage) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (paragraph.length <= maxCharsPerPage) {
      current = paragraph;
      continue;
    }

    const chunks = paragraph.match(new RegExp(`.{1,${maxCharsPerPage}}`, "g")) ?? [paragraph];
    for (const chunk of chunks) {
      pages.push(chunk.trim());
      if (pages.length >= maxPages) {
        return pages;
      }
    }
  }

  pushCurrent();
  if (pages.length === 0) {
    return [compact.slice(0, maxCharsPerPage)];
  }
  return pages.slice(0, maxPages);
}
