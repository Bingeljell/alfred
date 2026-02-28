import type { WebSearchProvider } from "./web_search_service";
import { SystemPromptCatalog } from "./system_prompt_catalog";

export type PlannerIntent = "chat" | "web_research" | "status_query" | "clarify" | "command";

export type PlannerDecision = {
  intent: PlannerIntent;
  confidence: number;
  needsWorker: boolean;
  query?: string;
  question?: string;
  provider?: WebSearchProvider;
  sendAttachment?: boolean;
  fileFormat?: "md" | "txt" | "doc";
  fileName?: string;
  reason: string;
};

export class IntentPlanner {
  private readonly llmService?: {
    generateText: (
      sessionId: string,
      input: string,
      options?: { authPreference?: "auto" | "oauth" | "api_key" }
    ) => Promise<{ text: string } | null>;
  };
  private readonly catalog: SystemPromptCatalog;
  private readonly enabled: boolean;
  private readonly minConfidence: number;

  constructor(options: {
    llmService?: {
      generateText: (
        sessionId: string,
        input: string,
        options?: { authPreference?: "auto" | "oauth" | "api_key" }
      ) => Promise<{ text: string } | null>;
    };
    systemPromptCatalog: SystemPromptCatalog;
    enabled?: boolean;
    minConfidence?: number;
  }) {
    this.llmService = options.llmService;
    this.catalog = options.systemPromptCatalog;
    this.enabled = options.enabled ?? true;
    this.minConfidence = options.minConfidence ?? 0.65;
  }

  async plan(
    sessionId: string,
    message: string,
    options?: { authPreference?: "auto" | "oauth" | "api_key"; hasActiveJob?: boolean }
  ): Promise<PlannerDecision> {
    const trimmed = message.trim();
    if (!trimmed) {
      return {
        intent: "clarify",
        confidence: 0.1,
        needsWorker: false,
        question: "What would you like me to help with?",
        reason: "empty_message"
      };
    }

    if (trimmed.startsWith("/")) {
      return {
        intent: "command",
        confidence: 1,
        needsWorker: false,
        reason: "explicit_command"
      };
    }

    if (!this.enabled || !this.llmService) {
      return heuristicPlan(trimmed, options?.hasActiveJob ?? false);
    }

    const policy = await this.catalog.load();
    const prompt = [
      "You are Alfred planner.",
      "Classify user input and choose a safe next action.",
      "",
      "Return ONLY strict JSON with this exact shape:",
      '{"intent":"chat|web_research|status_query|clarify|command","confidence":0.0,"needsWorker":true,"query":"","question":"","provider":"searxng|openai|brave|perplexity|brightdata|auto","sendAttachment":false,"fileFormat":"md|txt|doc","fileName":"","reason":""}',
      "",
      "Rules:",
      "- Use intent=status_query when user asks progress/status/check-in.",
      "- Use intent=web_research for web research/comparison tasks.",
      "- For recommendation asks, ask clarification ONLY if key constraints are missing (budget/platform/priorities).",
      "- If recommendation request already includes constraints, do not clarify; proceed with web_research.",
      "- Set sendAttachment=true only when user explicitly asks to create and send a file/doc back.",
      "- Default fileFormat to md unless user clearly requests txt/doc.",
      "- Use intent=clarify when the request is ambiguous.",
      "- If confidence is low (<0.65), prefer clarify.",
      "- Keep reason short.",
      "",
      `hasActiveJob: ${String(Boolean(options?.hasActiveJob))}`,
      `userMessage: ${trimmed}`,
      "",
      "System policy context:",
      policy
    ].join("\n");

    try {
      const plannerSessionId = `${sessionId}::planner`;
      const result = await this.llmService.generateText(plannerSessionId, prompt, {
        authPreference: options?.authPreference ?? "auto"
      });
      const parsed = parsePlannerJson(result?.text ?? "");
      if (!parsed) {
        return heuristicPlan(trimmed, options?.hasActiveJob ?? false);
      }

      const normalized: PlannerDecision = {
        intent: normalizeIntent(parsed.intent),
        confidence: clampConfidence(parsed.confidence),
        needsWorker: Boolean(parsed.needsWorker),
        query: typeof parsed.query === "string" ? parsed.query.trim() : undefined,
        question: typeof parsed.question === "string" ? parsed.question.trim() : undefined,
        provider: normalizeProvider(parsed.provider),
        sendAttachment: Boolean(parsed.sendAttachment),
        fileFormat: normalizeFileFormat(parsed.fileFormat),
        fileName: normalizeFileName(parsed.fileName),
        reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "llm_planner"
      };

      if (normalized.intent === "clarify" && !normalized.question) {
        normalized.question = "Can you clarify what output you want first?";
      }
      if (normalized.confidence < this.minConfidence && normalized.intent !== "clarify") {
        return {
          intent: "clarify",
          confidence: normalized.confidence,
          needsWorker: false,
          question: `I want to make sure I do this right. ${buildClarifyQuestion(trimmed)}`,
          reason: "low_confidence_clarify"
        };
      }

      return normalized;
    } catch {
      return heuristicPlan(trimmed, options?.hasActiveJob ?? false);
    }
  }
}

function heuristicPlan(message: string, hasActiveJob: boolean): PlannerDecision {
  const normalized = message.trim().toLowerCase();
  const compact = normalized.replace(/[!?.,]+$/g, "");
  const statusQuery =
    compact === "status" ||
    compact === "progress" ||
    compact === "update" ||
    /(?:what(?:'s| is)?\s+the\s+status|how(?:'s| is)\s+it\s+going|any\s+update|job\s+status)/i.test(normalized);
  if (statusQuery && hasActiveJob) {
    return {
      intent: "status_query",
      confidence: 0.9,
      needsWorker: false,
      reason: "heuristic_status_query"
    };
  }

  const researchSignals =
    normalized.includes("research") ||
    normalized.includes("compare") ||
    normalized.includes("best ") ||
    normalized.includes("top ") ||
    normalized.includes("recommend") ||
    normalized.includes("web search") ||
    normalized.includes("one at a time");

  if (looksLikeRecommendationAsk(normalized) && !hasRecommendationConstraints(normalized)) {
    return {
      intent: "clarify",
      confidence: 0.62,
      needsWorker: false,
      question: "Before I recommend one option, what matters most: cost, quality, speed, ecosystem, or privacy?",
      reason: "heuristic_recommendation_missing_constraints"
    };
  }

  if (researchSignals && message.length >= 18) {
    const sendAttachment = wantsAttachment(message);
    return {
      intent: "web_research",
      confidence: 0.75,
      needsWorker: true,
      query: message.trim(),
      provider: "auto",
      sendAttachment,
      fileFormat: detectFileFormat(message),
      reason: "heuristic_research_route"
    };
  }

  if (message.trim().split(/\s+/).length <= 2) {
    return {
      intent: "clarify",
      confidence: 0.45,
      needsWorker: false,
      question: buildClarifyQuestion(message),
      reason: "heuristic_ambiguous"
    };
  }

  return {
    intent: "chat",
    confidence: 0.7,
    needsWorker: false,
    reason: "heuristic_chat"
  };
}

function buildClarifyQuestion(message: string): string {
  return `You asked: "${message.trim()}". Do you want a quick answer, deeper research, or an action plan?`;
}

function looksLikeRecommendationAsk(normalized: string): boolean {
  return /\b(recommend|which\s+.*\bshould\s+i\s+use|what\s+should\s+i\s+use)\b/i.test(normalized);
}

function hasRecommendationConstraints(normalized: string): boolean {
  const signals = [
    /\b(budget|cost|price|\$|cheap|expensive)\b/i,
    /\b(speed|latency|performance|throughput)\b/i,
    /\b(quality|accuracy|fidelity)\b/i,
    /\b(mac|windows|linux|ios|android|platform|desktop|mobile)\b/i,
    /\b(open source|license|privacy|self[- ]?hosted|cloud)\b/i,
    /\b(integration|workflow|team|enterprise|personal)\b/i
  ];
  return signals.some((pattern) => pattern.test(normalized));
}

function parsePlannerJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const direct = tryParseJson(text);
  if (direct) {
    return direct;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJson(text.slice(start, end + 1));
  }
  return null;
}

function tryParseJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeIntent(raw: unknown): PlannerIntent {
  if (typeof raw !== "string") {
    return "chat";
  }
  const value = raw.trim().toLowerCase();
  if (value === "web_research") {
    return "web_research";
  }
  if (value === "status_query") {
    return "status_query";
  }
  if (value === "clarify") {
    return "clarify";
  }
  if (value === "command") {
    return "command";
  }
  return "chat";
}

function normalizeProvider(raw: unknown): WebSearchProvider | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (
    value === "searxng" ||
    value === "openai" ||
    value === "brave" ||
    value === "perplexity" ||
    value === "brightdata" ||
    value === "auto"
  ) {
    return value;
  }
  return undefined;
}

function normalizeFileFormat(raw: unknown): "md" | "txt" | "doc" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "md" || value === "txt" || value === "doc") {
    return value;
  }
  return undefined;
}

function normalizeFileName(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 80);
}

function wantsAttachment(message: string): boolean {
  const normalized = message.toLowerCase();
  const asksSend = /\b(send|share|deliver|attach)\b/.test(normalized);
  const asksFile = /\b(file|doc|document|attachment|pdf|markdown|txt)\b/.test(normalized);
  return asksSend && asksFile;
}

function detectFileFormat(message: string): "md" | "txt" | "doc" {
  const normalized = message.toLowerCase();
  if (/\bmarkdown|\.md\b/.test(normalized)) {
    return "md";
  }
  if (/\btxt|text file\b/.test(normalized)) {
    return "txt";
  }
  if (/\bdoc|word\b/.test(normalized)) {
    return "doc";
  }
  return "md";
}

function clampConfidence(raw: unknown): number {
  const numeric = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, numeric));
}
