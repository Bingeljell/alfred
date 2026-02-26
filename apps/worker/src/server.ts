import fs from "node:fs/promises";
import path from "node:path";
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
import { startWorker } from "./worker";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const pagedResponseStore = new PagedResponseStore(config.stateDir);
  const supervisorStore = new SupervisorStore(config.stateDir);
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

  await store.ensureReady();
  await notificationStore.ensureReady();
  await pagedResponseStore.ensureReady();
  await supervisorStore.ensureReady();
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
  const processor: Parameters<typeof startWorker>[0]["processor"] = async (job, context) => {
    const taskType = String(job.payload.taskType ?? "").trim().toLowerCase();
    const sessionId = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
    const authSessionId =
      typeof job.payload.authSessionId === "string" && job.payload.authSessionId.trim()
        ? job.payload.authSessionId.trim()
        : sessionId;
    const authPreference = normalizeAuthPreference(job.payload.authPreference);

    if (taskType === "chat_turn") {
      const input = String(job.payload.text ?? "").trim();
      if (!input) {
        return {
          summary: "chat_turn_missing_input",
          responseText: "Follow-up could not run: missing input text."
        };
      }
      await context.reportProgress({
        step: "planning",
        message: "Running queued follow-up turn..."
      });
      const generated = await llmService.generateText(authSessionId || sessionId, input, { authPreference });
      const text = generated?.text?.trim();
      if (!text) {
        return {
          summary: "chat_turn_no_response",
          responseText: "No model response is available for this follow-up turn."
        };
      }
      return {
        summary: "chat_turn_completed",
        responseText: text
      };
    }

    if (taskType !== "web_search" && taskType !== "web_to_file") {
      const action = String(job.payload.action ?? job.payload.text ?? job.type);
      return {
        summary: `processed:${action}`,
        processedAt: new Date().toISOString()
      };
    }

    const query = String(job.payload.query ?? "").trim();
    const provider = normalizeWebSearchProvider(job.payload.provider) ?? config.alfredWebSearchProvider;
    const maxRetries = clampInt(job.payload.maxRetries, 0, 5, 1);
    const timeBudgetMs = clampInt(job.payload.timeBudgetMs, 5000, 10 * 60 * 1000, 120_000);
    const tokenBudget = clampInt(job.payload.tokenBudget, 128, 50_000, 8_000);

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

    let attempt = 0;
    let resultText = "";
    let resultProvider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | null = null;
    let lastError: unknown = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      await context.reportProgress({
        step: "searching",
        message: `Searching via ${provider} (attempt ${attempt}/${maxRetries + 1})...`
      });
      try {
        const result = await withTimeout(
          webSearchService.search(query, {
            provider,
            authSessionId,
            authPreference
          }),
          timeBudgetMs,
          "web_search_time_budget_exceeded"
        );
        if (result?.text?.trim()) {
          resultText = result.text.trim();
          resultProvider = result.provider;
          break;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt <= maxRetries) {
        await context.reportProgress({
          step: "retrying",
          message: `Retrying web search (${attempt}/${maxRetries})...`
        });
      }
    }

    if (!resultText || !resultProvider) {
      const reason = lastError instanceof Error ? lastError.message : "no_result";
      return {
        summary: "web_search_no_results",
        responseText: `No web search result is available for this query. Reason: ${reason}`
      };
    }

    if (taskType === "web_to_file") {
      const fileFormat = normalizeAttachmentFormat(job.payload.fileFormat) ?? "md";
      const safeFileName = buildAttachmentFileName(job.payload.fileName, query, fileFormat);
      const targetDir = path.resolve(config.alfredWorkspaceDir, "notes", "generated");
      const targetPath = path.resolve(targetDir, safeFileName);
      if (!(targetPath === targetDir || targetPath.startsWith(`${targetDir}${path.sep}`))) {
        return {
          summary: "web_to_file_invalid_path",
          responseText: "Could not create output file due to invalid path policy."
        };
      }

      await context.reportProgress({
        step: "drafting",
        message: `Drafting ${fileFormat.toUpperCase()} document...`
      });
      const attachmentText = await composeAttachmentText({
        llmService,
        authSessionId: authSessionId || sessionId,
        authPreference,
        query,
        provider: resultProvider,
        sourceText: resultText,
        fileFormat
      });
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(targetPath, attachmentText.endsWith("\n") ? attachmentText : `${attachmentText}\n`, "utf8");

      if (sessionId) {
        await context.reportProgress({
          step: "dispatch",
          message: "Sending document attachment..."
        });
        await notificationStore.enqueue({
          kind: "file",
          sessionId,
          filePath: targetPath,
          fileName: safeFileName,
          mimeType: attachmentMimeType(fileFormat),
          caption: `Research doc: ${query.slice(0, 80)}`
        });
      }

      const relativePath = path.relative(config.alfredWorkspaceDir, targetPath).replace(/\\/g, "/");
      return {
        summary: `web_to_file_${resultProvider}`,
        responseText: `Research complete via ${resultProvider}. Wrote workspace/${relativePath} and sent it as an attachment.`,
        provider: resultProvider,
        retriesUsed: Math.max(0, attempt - 1),
        tokenBudget,
        filePath: relativePath,
        fileFormat
      };
    }

    await context.reportProgress({
      step: "synthesizing",
      message: "Formatting final response..."
    });
    const fullText = `Web search provider: ${resultProvider}\n${resultText}`;
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
      summary: `web_search_${resultProvider}`,
      responseText,
      provider: resultProvider,
      pageCount: pages.length,
      retriesUsed: Math.max(0, attempt - 1),
      tokenBudget
    };
  };

  const onStatusChange: Parameters<typeof startWorker>[0]["onStatusChange"] = async (event) => {
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

    if (text) {
      await notificationStore.enqueue({
        sessionId: event.sessionId,
        jobId: event.jobId,
        status,
        text
      });
    }

    const job = await store.getJob(event.jobId);
    const supervisorId =
      job && typeof job.payload.supervisorId === "string" && job.payload.supervisorId.trim()
        ? job.payload.supervisorId.trim()
        : "";
    if (supervisorId) {
      const update = await supervisorStore.updateChildByJob(event.jobId, {
        status: event.status === "progress" ? "running" : event.status,
        summary: event.summary,
        error: event.status === "failed" ? event.summary : undefined,
        retriesUsed:
          job && typeof job.result?.retriesUsed === "number" && Number.isFinite(job.result?.retriesUsed)
            ? Math.max(0, Math.floor(job.result.retriesUsed))
            : undefined
      });
      if (update && update.transitionedToTerminal) {
        await notificationStore.enqueue({
          sessionId: update.run.sessionId,
          status: update.run.status === "completed" ? "succeeded" : "failed",
          jobId: event.jobId,
          text: supervisorStore.summarize(update.run)
        });
      }
    }

    if (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") {
      jobNotificationState.delete(event.jobId);
    }
  };

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

function normalizeWebSearchProvider(
  raw: unknown
): "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto" | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "searxng" || value === "openai" || value === "brave" || value === "perplexity" || value === "brightdata" || value === "auto") {
    return value;
  }
  return null;
}

function normalizeAttachmentFormat(raw: unknown): "md" | "txt" | "doc" | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "md" || value === "txt" || value === "doc") {
    return value;
  }
  return null;
}

function buildAttachmentFileName(raw: unknown, query: string, fileFormat: "md" | "txt" | "doc"): string {
  if (typeof raw === "string" && raw.trim()) {
    const sanitized = raw
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
    if (sanitized) {
      return ensureExtension(sanitized, fileFormat);
    }
  }

  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const day = new Date().toISOString().slice(0, 10);
  const base = slug || "research";
  return `${base}_${day}.${fileFormat}`;
}

function ensureExtension(fileName: string, ext: "md" | "txt" | "doc"): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(`.${ext}`)) {
    return fileName;
  }
  return `${fileName}.${ext}`;
}

function attachmentMimeType(format: "md" | "txt" | "doc"): string {
  if (format === "md") {
    return "text/markdown";
  }
  if (format === "txt") {
    return "text/plain";
  }
  return "application/msword";
}

async function composeAttachmentText(input: {
  llmService: HybridLlmService;
  authSessionId: string;
  authPreference: "auto" | "oauth" | "api_key";
  query: string;
  provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata";
  sourceText: string;
  fileFormat: "md" | "txt" | "doc";
}): Promise<string> {
  const formatLabel = input.fileFormat === "md" ? "markdown" : input.fileFormat === "txt" ? "plain text" : "word-friendly plain text";
  const prompt = [
    "You are formatting research notes for delivery as a file attachment.",
    `Output format: ${formatLabel}.`,
    "Keep it concise and practical.",
    "Include sections: Summary, Top options, Comparison, Sources.",
    "Do not invent sources; only use what is provided.",
    "",
    `Query: ${input.query}`,
    `Provider: ${input.provider}`,
    "",
    "Search results:",
    input.sourceText
  ].join("\n");

  try {
    const generated = await input.llmService.generateText(input.authSessionId, prompt, {
      authPreference: input.authPreference
    });
    const text = generated?.text?.trim();
    if (text) {
      return text;
    }
  } catch {
    // fall back to deterministic formatting
  }

  return [
    `Research notes for: ${input.query}`,
    `Source provider: ${input.provider}`,
    "",
    "Summary:",
    input.sourceText.slice(0, 2400)
  ].join("\n");
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

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const value = Math.floor(numeric);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
