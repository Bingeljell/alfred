import type { RunSpecV1 } from "../../../../packages/contracts/src";
import type { WorkerProcessor } from "../worker";
import { executeRunSpec } from "../run_spec_executor";

type AuthPreference = "auto" | "oauth" | "api_key";
type SearchProvider = "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
type AttachmentFormat = "md" | "txt" | "doc";

export function createWorkerProcessor(input: {
  config: {
    alfredWorkspaceDir: string;
    alfredWebSearchProvider: SearchProvider;
  };
  webSearchService: {
    search: (
      query: string,
      options: {
        provider?: SearchProvider;
        authSessionId: string;
        authPreference?: AuthPreference;
      }
    ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
  };
  llmService: {
    generateText: (
      sessionId: string,
      input: string,
      options?: { authPreference?: AuthPreference }
    ) => Promise<{ text: string } | null>;
  };
  pagedResponseStore: {
    setPages: (sessionId: string, pages: string[]) => Promise<void>;
    clear: (sessionId: string) => Promise<void>;
  };
  notificationStore: {
    enqueue: (item: {
      sessionId: string;
      status?: string;
      text?: string;
      jobId?: string;
      kind?: "text" | "file";
      filePath?: string;
      fileName?: string;
      mimeType?: string;
      caption?: string;
    }) => Promise<unknown>;
  };
  runSpecStore: {
    put: (input: {
      runId: string;
      sessionId: string;
      spec: RunSpecV1;
      status: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
      jobId?: string;
      approvedStepIds?: string[];
      parentRunId?: string;
    }) => Promise<unknown>;
    setStatus: (
      runId: string,
      status: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled",
      options?: { message?: string; payload?: Record<string, unknown> }
    ) => Promise<unknown>;
    updateStep: (
      runId: string,
      stepId: string,
      input: {
        status: "pending" | "approval_required" | "approved" | "running" | "completed" | "failed" | "cancelled" | "skipped";
        message?: string;
        output?: Record<string, unknown>;
        attempts?: number;
      }
    ) => Promise<unknown>;
  };
}): WorkerProcessor {
  return async (job, context) => {
    const taskType = String(job.payload.taskType ?? "").trim().toLowerCase();
    const sessionId = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
    const authSessionId =
      typeof job.payload.authSessionId === "string" && job.payload.authSessionId.trim()
        ? job.payload.authSessionId.trim()
        : sessionId;
    const authPreference = normalizeAuthPreference(job.payload.authPreference);

    if (taskType === "run_spec") {
      const runSpec = parseRunSpec(job.payload.runSpec);
      if (!runSpec) {
        throw new Error("RunSpec payload is missing or invalid.");
      }
      const runId = typeof job.payload.runSpecRunId === "string" ? job.payload.runSpecRunId.trim() : "";
      const approvedStepIds = Array.isArray(job.payload.approvedStepIds)
        ? job.payload.approvedStepIds
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0)
        : [];

      const effectiveRunId = runId || job.id;
      await input.runSpecStore.put({
        runId: effectiveRunId,
        sessionId: sessionId || authSessionId,
        spec: runSpec,
        status: "running",
        jobId: job.id,
        approvedStepIds
      });

      const runResult = await executeRunSpec({
        runId: effectiveRunId,
        sessionId: sessionId || authSessionId,
        authSessionId: authSessionId || sessionId,
        authPreference,
        runSpec,
        approvedStepIds,
        workspaceDir: input.config.alfredWorkspaceDir,
        webSearchService: input.webSearchService,
        llmService: input.llmService,
        notificationStore: input.notificationStore,
        runSpecStore: input.runSpecStore,
        reportProgress: context.reportProgress
      });
      if (runResult.summary === "run_spec_failed" || runResult.summary === "run_spec_approval_missing") {
        throw new Error(runResult.responseText || runResult.summary);
      }
      return runResult;
    }

    if (taskType === "web_to_file") {
      const query = String(job.payload.query ?? "").trim();
      const legacySpec = buildLegacyWebToFileRunSpec({
        runId: job.id,
        query,
        provider: normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider,
        fileFormat: normalizeAttachmentFormat(job.payload.fileFormat) ?? "md",
        fileName: typeof job.payload.fileName === "string" ? job.payload.fileName : undefined,
        sessionId
      });
      await input.runSpecStore.put({
        runId: job.id,
        sessionId: sessionId || authSessionId,
        spec: legacySpec,
        status: "running",
        jobId: job.id,
        approvedStepIds: legacySpec.steps.filter((step) => step.approval?.required !== true).map((step) => step.id)
      });

      const runResult = await executeRunSpec({
        runId: job.id,
        sessionId: sessionId || authSessionId,
        authSessionId: authSessionId || sessionId,
        authPreference,
        runSpec: legacySpec,
        approvedStepIds: legacySpec.steps.map((step) => step.id),
        workspaceDir: input.config.alfredWorkspaceDir,
        webSearchService: input.webSearchService,
        llmService: input.llmService,
        notificationStore: input.notificationStore,
        runSpecStore: input.runSpecStore,
        reportProgress: context.reportProgress
      });
      if (runResult.summary === "run_spec_failed" || runResult.summary === "run_spec_approval_missing") {
        throw new Error(runResult.responseText || runResult.summary);
      }
      return runResult;
    }

    if (taskType === "chat_turn") {
      const turnInput = String(job.payload.text ?? "").trim();
      if (!turnInput) {
        return {
          summary: "chat_turn_missing_input",
          responseText: "Follow-up could not run: missing input text."
        };
      }
      await context.reportProgress({
        step: "planning",
        message: "Running queued follow-up turn..."
      });
      const generated = await input.llmService.generateText(authSessionId || sessionId, turnInput, { authPreference });
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

    if (taskType === "agentic_turn") {
      const goal = String(job.payload.query ?? job.payload.goal ?? job.payload.text ?? "").trim();
      const provider = normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider;
      const maxRetries = clampInt(job.payload.maxRetries, 0, 5, 1);
      const timeBudgetMs = clampInt(job.payload.timeBudgetMs, 5000, 10 * 60 * 1000, 120_000);
      const tokenBudget = clampInt(job.payload.tokenBudget, 128, 50_000, 8_000);

      if (!goal) {
        return {
          summary: "agentic_turn_missing_goal",
          responseText: "I could not start this task because no goal text was provided."
        };
      }

      await context.reportProgress({
        step: "planning",
        message: "Planning the best approach..."
      });

      let searchText = "";
      let searchProvider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | null = null;
      let searchError: unknown = null;
      let attempt = 0;
      while (attempt <= maxRetries) {
        attempt += 1;
        await context.reportProgress({
          step: "searching",
          message: `Collecting context via ${provider} (attempt ${attempt}/${maxRetries + 1})...`
        });
        try {
          const result = await withTimeout(
            input.webSearchService.search(goal, {
              provider,
              authSessionId,
              authPreference
            }),
            timeBudgetMs,
            "agentic_turn_search_time_budget_exceeded"
          );
          if (result?.text?.trim()) {
            searchText = result.text.trim();
            searchProvider = result.provider;
            break;
          }
        } catch (error) {
          searchError = error;
        }

        if (attempt <= maxRetries) {
          await context.reportProgress({
            step: "retrying",
            message: `Retrying context collection (${attempt}/${maxRetries})...`
          });
        }
      }

      if (!searchText || !searchProvider) {
        const reason = searchError instanceof Error ? searchError.message : "no_result";
        return {
          summary: "agentic_turn_no_context",
          responseText: `I couldn't gather web context for this request. Reason: ${reason}`
        };
      }

      await context.reportProgress({
        step: "synthesizing",
        message: "Synthesizing findings into a concise answer..."
      });

      const synthesisPrompt = buildAgenticSynthesisPrompt(goal, searchProvider, searchText);
      let synthesisText = "";
      try {
        const generated = await withTimeout(
          input.llmService.generateText(authSessionId || sessionId, synthesisPrompt, { authPreference }),
          timeBudgetMs,
          "agentic_turn_synthesis_time_budget_exceeded"
        );
        synthesisText = typeof generated?.text === "string" ? generated.text.trim() : "";
      } catch {
        synthesisText = "";
      }

      const fullText = synthesisText || renderFallbackSearchResponse(searchProvider, searchText, goal);
      const pages = paginateResponse(fullText, 1600, 8);
      const firstPage = pages[0] ?? fullText;
      if (sessionId && pages.length > 1) {
        await input.pagedResponseStore.setPages(sessionId, pages.slice(1));
      } else if (sessionId) {
        await input.pagedResponseStore.clear(sessionId);
      }

      const responseText =
        pages.length > 1 ? `${firstPage}\n\nReply #next for more (${pages.length - 1} remaining).` : firstPage;

      return {
        summary: `agentic_turn_${searchProvider}`,
        responseText,
        provider: searchProvider,
        mode: "agentic_turn",
        pageCount: pages.length,
        retriesUsed: Math.max(0, attempt - 1),
        tokenBudget
      };
    }

    if (taskType !== "web_search") {
      const action = String(job.payload.action ?? job.payload.text ?? job.type);
      return {
        summary: `processed:${action}`,
        processedAt: new Date().toISOString()
      };
    }

    const query = String(job.payload.query ?? "").trim();
    const provider = normalizeWebSearchProvider(job.payload.provider) ?? input.config.alfredWebSearchProvider;
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
          input.webSearchService.search(query, {
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

    await context.reportProgress({
      step: "synthesizing",
      message: "Formatting final response..."
    });
    const fullText = `Web search provider: ${resultProvider}\n${resultText}`;
    const pages = paginateResponse(fullText, 1400, 8);
    const firstPage = pages[0] ?? fullText;
    if (sessionId && pages.length > 1) {
      await input.pagedResponseStore.setPages(sessionId, pages.slice(1));
    } else if (sessionId) {
      await input.pagedResponseStore.clear(sessionId);
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
}

function normalizeAuthPreference(raw: unknown): AuthPreference {
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

function normalizeWebSearchProvider(raw: unknown): SearchProvider | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "searxng" || value === "openai" || value === "brave" || value === "perplexity" || value === "brightdata" || value === "auto") {
    return value;
  }
  return null;
}

function normalizeAttachmentFormat(raw: unknown): AttachmentFormat | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "md" || value === "txt" || value === "doc") {
    return value;
  }
  return null;
}

function parseRunSpec(raw: unknown): RunSpecV1 | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  if (typeof record.goal !== "string" || !record.goal.trim()) {
    return null;
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    return null;
  }

  const steps = record.steps
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const step = item as Record<string, unknown>;
      if (typeof step.id !== "string" || !step.id.trim()) {
        return null;
      }
      if (typeof step.type !== "string" || !step.type.trim()) {
        return null;
      }
      if (typeof step.name !== "string" || !step.name.trim()) {
        return null;
      }
      const parsedInput = step.input && typeof step.input === "object" ? (step.input as Record<string, unknown>) : {};
      const approval =
        step.approval && typeof step.approval === "object"
          ? {
              required: Boolean((step.approval as Record<string, unknown>).required),
              capability:
                typeof (step.approval as Record<string, unknown>).capability === "string"
                  ? String((step.approval as Record<string, unknown>).capability)
                  : "file_write"
            }
          : undefined;
      return {
        id: step.id.trim(),
        type: step.type.trim() as "web.search" | "doc.compose" | "file.write" | "channel.send_attachment",
        name: step.name.trim(),
        input: parsedInput,
        approval
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (steps.length === 0) {
    return null;
  }

  return {
    version: 1,
    id: record.id.trim(),
    goal: record.goal.trim(),
    metadata: record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {},
    steps
  };
}

function buildAgenticSynthesisPrompt(
  goal: string,
  provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata",
  toolOutput: string
): string {
  return [
    "You are Alfred, a practical execution agent.",
    "The user asked for web research. Produce a useful, concise answer.",
    "Requirements:",
    "- Start with a 3-6 bullet executive summary.",
    "- Then include top options with short rationale.",
    "- Include source links inline for factual claims.",
    "- If data quality is weak, say so briefly.",
    "- Avoid boilerplate and avoid listing raw provider dumps.",
    "",
    `User goal: ${goal}`,
    `Web tool provider: ${provider}`,
    "",
    "Tool observations:",
    toolOutput
  ].join("\n");
}

function renderFallbackSearchResponse(
  provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata",
  searchText: string,
  goal: string
): string {
  return [
    `I gathered web context via ${provider}, but synthesis failed. Here's the raw result for: ${goal}`,
    "",
    searchText
  ].join("\n");
}

function buildLegacyWebToFileRunSpec(input: {
  runId: string;
  query: string;
  provider: SearchProvider;
  fileFormat: AttachmentFormat;
  fileName?: string;
  sessionId?: string;
}): RunSpecV1 {
  const safeFileName = buildAttachmentFileName(input.fileName, input.query, input.fileFormat);
  return {
    version: 1,
    id: `legacy-${input.runId}`,
    goal: `Research and send attachment for query: ${input.query}`,
    metadata: {
      migratedFrom: "web_to_file"
    },
    steps: [
      {
        id: "search",
        type: "web.search",
        name: "Web Search",
        input: {
          query: input.query,
          provider: input.provider
        }
      },
      {
        id: "compose",
        type: "doc.compose",
        name: "Compose Document",
        input: {
          query: input.query,
          fileFormat: input.fileFormat
        }
      },
      {
        id: "write",
        type: "file.write",
        name: "Write File",
        input: {
          fileFormat: input.fileFormat,
          fileName: safeFileName
        }
      },
      {
        id: "send",
        type: "channel.send_attachment",
        name: "Send Attachment",
        input: {
          sessionId: input.sessionId,
          caption: `Research doc: ${input.query.slice(0, 80)}`
        }
      }
    ]
  };
}

function buildAttachmentFileName(raw: unknown, query: string, fileFormat: AttachmentFormat): string {
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

function ensureExtension(fileName: string, ext: AttachmentFormat): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(`.${ext}`)) {
    return fileName;
  }
  return `${fileName}.${ext}`;
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
