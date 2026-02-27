import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3000))
    .pipe(z.number().int().min(1).max(65535)),
  STATE_DIR: z.string().optional().default("./state"),
  WORKER_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 250))
    .pipe(z.number().int().min(25).max(60000)),
  WORKER_CONCURRENCY: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 1))
    .pipe(z.number().int().min(1).max(8)),
  NOTIFICATION_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 250))
    .pipe(z.number().int().min(25).max(60000)),
  REMINDER_POLL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 500))
    .pipe(z.number().int().min(100).max(60000)),
  MEMORY_COMPACTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  MEMORY_COMPACTION_INTERVAL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 60 * 60 * 1000))
    .pipe(z.number().int().min(60_000).max(24 * 60 * 60 * 1000)),
  MEMORY_COMPACTION_MAX_DAYS_PER_RUN: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 2))
    .pipe(z.number().int().min(1).max(30)),
  MEMORY_COMPACTION_MIN_EVENTS_PER_DAY: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 6))
    .pipe(z.number().int().min(1).max(500)),
  MEMORY_COMPACTION_MAX_EVENTS_PER_DAY: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 600))
    .pipe(z.number().int().min(20).max(5000)),
  MEMORY_COMPACTION_MAX_NOTE_CHARS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 8000))
    .pipe(z.number().int().min(400).max(20_000)),
  MEMORY_COMPACTION_SESSION_ID: z.string().optional().default("owner@s.whatsapp.net"),
  HEARTBEAT_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_INTERVAL_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30 * 60 * 1000))
    .pipe(z.number().int().min(15000).max(24 * 60 * 60 * 1000)),
  HEARTBEAT_ACTIVE_HOURS_START: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 9))
    .pipe(z.number().int().min(0).max(23)),
  HEARTBEAT_ACTIVE_HOURS_END: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 22))
    .pipe(z.number().int().min(0).max(23)),
  HEARTBEAT_REQUIRE_IDLE_QUEUE: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_DEDUPE_WINDOW_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 2 * 60 * 60 * 1000))
    .pipe(z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000)),
  HEARTBEAT_SUPPRESS_OK: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_SESSION_ID: z.string().optional().default("owner@s.whatsapp.net"),
  HEARTBEAT_PENDING_NOTIFICATION_ALERT_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 5))
    .pipe(z.number().int().min(1).max(1000)),
  HEARTBEAT_ERROR_LOOKBACK_MINUTES: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 120))
    .pipe(z.number().int().min(1).max(24 * 60)),
  HEARTBEAT_ALERT_ON_AUTH_DISCONNECTED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_ALERT_ON_WHATSAPP_DISCONNECTED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_ALERT_ON_STUCK_JOBS: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  HEARTBEAT_STUCK_JOB_THRESHOLD_MINUTES: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30))
    .pipe(z.number().int().min(1).max(24 * 60)),
  STREAM_MAX_EVENTS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 5000))
    .pipe(z.number().int().min(200).max(200000)),
  STREAM_RETENTION_DAYS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 14))
    .pipe(z.number().int().min(1).max(365)),
  STREAM_DEDUPE_WINDOW_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 2500))
    .pipe(z.number().int().min(0).max(60000)),
  PUBLIC_BASE_URL: z.string().optional().default("http://localhost:3000"),
  ALFRED_WORKSPACE_DIR: z.string().optional().default("./workspace/alfred"),
  ALFRED_APPROVAL_MODE: z.enum(["strict", "balanced", "relaxed"]).optional().default("balanced"),
  ALFRED_APPROVAL_DEFAULT: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  ALFRED_PLANNER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  ALFRED_PLANNER_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0.65))
    .pipe(z.number().min(0).max(1)),
  ALFRED_PLANNER_SYSTEM_FILES: z
    .string()
    .optional()
    .default("docs/alfred_identity.md,docs/alfred_capabilities.md,docs/alfred_policies.md"),
  ALFRED_WEB_SEARCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  ALFRED_WEB_SEARCH_REQUIRE_APPROVAL: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  ALFRED_WEB_SEARCH_PROVIDER: z.enum(["searxng", "openai", "brave", "perplexity", "brightdata", "auto"]).optional().default("searxng"),
  ALFRED_FILE_WRITE_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  ALFRED_FILE_WRITE_REQUIRE_APPROVAL: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  ALFRED_FILE_WRITE_NOTES_ONLY: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  ALFRED_FILE_WRITE_NOTES_DIR: z.string().optional().default("notes"),
  ALFRED_FILE_WRITE_APPROVAL_MODE: z.enum(["per_action", "session", "always"]).optional().default("session"),
  ALFRED_FILE_WRITE_APPROVAL_SCOPE: z.enum(["auth", "channel"]).optional().default("auth"),
  ALFRED_SHELL_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  ALFRED_SHELL_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20000))
    .pipe(z.number().int().min(1000).max(120000)),
  ALFRED_SHELL_MAX_OUTPUT_CHARS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 8000))
    .pipe(z.number().int().min(500).max(50000)),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  BRAVE_SEARCH_URL: z.string().optional().default("https://api.search.brave.com/res/v1/web/search"),
  BRAVE_SEARCH_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 12000))
    .pipe(z.number().int().min(1000).max(60000)),
  BRAVE_SEARCH_MAX_RESULTS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 5))
    .pipe(z.number().int().min(1).max(20)),
  SEARXNG_SEARCH_URL: z.string().optional().default("http://127.0.0.1:8080/search"),
  SEARXNG_SEARCH_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 12000))
    .pipe(z.number().int().min(1000).max(60000)),
  SEARXNG_SEARCH_MAX_RESULTS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 5))
    .pipe(z.number().int().min(1).max(20)),
  SEARXNG_SEARCH_LANGUAGE: z.string().optional().default("en"),
  SEARXNG_SEARCH_SAFESEARCH: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 1))
    .pipe(z.number().int().min(0).max(2)),
  BRIGHTDATA_API_KEY: z.string().optional(),
  BRIGHTDATA_SERP_URL: z.string().optional().default("https://api.brightdata.com/request"),
  BRIGHTDATA_ZONE: z.string().optional(),
  BRIGHTDATA_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 15000))
    .pipe(z.number().int().min(1000).max(120000)),
  BRIGHTDATA_MAX_RESULTS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 5))
    .pipe(z.number().int().min(1).max(20)),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_SEARCH_URL: z.string().optional().default("https://api.perplexity.ai/chat/completions"),
  PERPLEXITY_MODEL: z.string().optional().default("sonar"),
  PERPLEXITY_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20000))
    .pipe(z.number().int().min(1000).max(120000)),
  OAUTH_STATE_TTL_SEC: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 600))
    .pipe(z.number().int().min(30).max(3600)),
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  OAUTH_OPENAI_MODE: z.enum(["mock", "live"]).optional().default("mock"),
  OAUTH_OPENAI_CLIENT_ID: z.string().optional(),
  OAUTH_OPENAI_CLIENT_SECRET: z.string().optional(),
  OAUTH_OPENAI_AUTHORIZE_URL: z.string().optional(),
  OAUTH_OPENAI_TOKEN_URL: z.string().optional(),
  OAUTH_OPENAI_SCOPE: z.string().optional().default("responses.read responses.write offline_access"),
  OPENAI_RESPONSES_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true)),
  OPENAI_RESPONSES_URL: z.string().optional().default("https://api.openai.com/v1/responses"),
  OPENAI_RESPONSES_MODEL: z.string().optional().default("gpt-4.1-mini"),
  OPENAI_RESPONSES_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 20000))
    .pipe(z.number().int().min(1000).max(120000)),
  OPENAI_API_KEY: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(["stdout", "baileys"]).optional().default("stdout"),
  WHATSAPP_BAILEYS_AUTO_CONNECT: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  WHATSAPP_BAILEYS_AUTH_DIR: z.string().optional(),
  WHATSAPP_BAILEYS_INBOUND_TOKEN: z.string().optional(),
  WHATSAPP_BAILEYS_ALLOW_SELF_FROM_ME: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  WHATSAPP_BAILEYS_REQUIRE_PREFIX: z.string().optional().default("/alfred"),
  WHATSAPP_BAILEYS_ALLOWED_SENDERS: z.string().optional(),
  WHATSAPP_BAILEYS_MAX_TEXT_CHARS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 4000))
    .pipe(z.number().int().min(200).max(16000)),
  WHATSAPP_BAILEYS_RECONNECT_DELAY_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3000))
    .pipe(z.number().int().min(500).max(60000)),
  WHATSAPP_BAILEYS_MAX_QR_GENERATIONS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 3))
    .pipe(z.number().int().min(1).max(20)),
  CODEX_APP_SERVER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : false)),
  CODEX_APP_SERVER_COMMAND: z.string().optional().default("codex"),
  CODEX_APP_SERVER_CLIENT_NAME: z.string().optional().default("alfred-gateway"),
  CODEX_APP_SERVER_CLIENT_VERSION: z.string().optional().default("0.1.0"),
  CODEX_AUTH_LOGIN_MODE: z.enum(["chatgpt", "chatgptAuthTokens", "apiKey"]).optional().default("chatgpt"),
  CODEX_MODEL: z.string().optional(),
  CODEX_TURN_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 120000))
    .pipe(z.number().int().min(5000).max(300000)),
  CODEX_ACCOUNT_REFRESH_BEFORE_TURN: z
    .string()
    .optional()
    .transform((v) => (v ? v.toLowerCase() !== "false" : true))
});

export type AppConfig = {
  port: number;
  stateDir: string;
  workerPollMs: number;
  workerConcurrency: number;
  notificationPollMs: number;
  reminderPollMs: number;
  memoryCompactionEnabled: boolean;
  memoryCompactionIntervalMs: number;
  memoryCompactionMaxDaysPerRun: number;
  memoryCompactionMinEventsPerDay: number;
  memoryCompactionMaxEventsPerDay: number;
  memoryCompactionMaxNoteChars: number;
  memoryCompactionSessionId: string;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  heartbeatActiveHoursStart: number;
  heartbeatActiveHoursEnd: number;
  heartbeatRequireIdleQueue: boolean;
  heartbeatDedupeWindowMs: number;
  heartbeatSuppressOk: boolean;
  heartbeatSessionId: string;
  heartbeatPendingNotificationAlertThreshold: number;
  heartbeatErrorLookbackMinutes: number;
  heartbeatAlertOnAuthDisconnected: boolean;
  heartbeatAlertOnWhatsAppDisconnected: boolean;
  heartbeatAlertOnStuckJobs: boolean;
  heartbeatStuckJobThresholdMinutes: number;
  streamMaxEvents: number;
  streamRetentionDays: number;
  streamDedupeWindowMs: number;
  publicBaseUrl: string;
  alfredWorkspaceDir: string;
  alfredApprovalMode: "strict" | "balanced" | "relaxed";
  alfredApprovalDefault: boolean;
  alfredPlannerEnabled: boolean;
  alfredPlannerMinConfidence: number;
  alfredPlannerSystemFiles: string[];
  alfredWebSearchEnabled: boolean;
  alfredWebSearchRequireApproval: boolean;
  alfredWebSearchProvider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
  alfredFileWriteEnabled: boolean;
  alfredFileWriteRequireApproval: boolean;
  alfredFileWriteNotesOnly: boolean;
  alfredFileWriteNotesDir: string;
  alfredFileWriteApprovalMode: "per_action" | "session" | "always";
  alfredFileWriteApprovalScope: "auth" | "channel";
  alfredShellEnabled: boolean;
  alfredShellTimeoutMs: number;
  alfredShellMaxOutputChars: number;
  braveSearchApiKey?: string;
  braveSearchUrl: string;
  braveSearchTimeoutMs: number;
  braveSearchMaxResults: number;
  searxngSearchUrl: string;
  searxngSearchTimeoutMs: number;
  searxngSearchMaxResults: number;
  searxngSearchLanguage: string;
  searxngSearchSafeSearch: number;
  brightDataApiKey?: string;
  brightDataSerpUrl: string;
  brightDataZone?: string;
  brightDataTimeoutMs: number;
  brightDataMaxResults: number;
  perplexityApiKey?: string;
  perplexitySearchUrl: string;
  perplexityModel: string;
  perplexityTimeoutMs: number;
  oauthStateTtlMs: number;
  oauthTokenEncryptionKey?: string;
  oauthOpenAiMode: "mock" | "live";
  oauthOpenAiClientId?: string;
  oauthOpenAiClientSecret?: string;
  oauthOpenAiAuthorizeUrl?: string;
  oauthOpenAiTokenUrl?: string;
  oauthOpenAiScope: string;
  openAiResponsesEnabled: boolean;
  openAiResponsesUrl: string;
  openAiResponsesModel: string;
  openAiResponsesTimeoutMs: number;
  openAiApiKey?: string;
  whatsAppProvider: "stdout" | "baileys";
  whatsAppBaileysAutoConnect: boolean;
  whatsAppBaileysAuthDir: string;
  whatsAppBaileysInboundToken?: string;
  whatsAppBaileysAllowSelfFromMe: boolean;
  whatsAppBaileysRequirePrefix?: string;
  whatsAppBaileysAllowedSenders: string[];
  whatsAppBaileysMaxTextChars: number;
  whatsAppBaileysReconnectDelayMs: number;
  whatsAppBaileysMaxQrGenerations: number;
  codexAppServerEnabled: boolean;
  codexAppServerCommand: string;
  codexAppServerClientName: string;
  codexAppServerClientVersion: string;
  codexAuthLoginMode: "chatgpt" | "chatgptAuthTokens" | "apiKey";
  codexModel?: string;
  codexTurnTimeoutMs: number;
  codexAccountRefreshBeforeTurn: boolean;
};

export function loadDotEnvFile(dotEnvPath = path.resolve(process.cwd(), ".env")): void {
  try {
    process.loadEnvFile(dotEnvPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);

  return {
    port: parsed.PORT,
    stateDir: path.resolve(parsed.STATE_DIR),
    workerPollMs: parsed.WORKER_POLL_MS,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    notificationPollMs: parsed.NOTIFICATION_POLL_MS,
    reminderPollMs: parsed.REMINDER_POLL_MS,
    memoryCompactionEnabled: parsed.MEMORY_COMPACTION_ENABLED,
    memoryCompactionIntervalMs: parsed.MEMORY_COMPACTION_INTERVAL_MS,
    memoryCompactionMaxDaysPerRun: parsed.MEMORY_COMPACTION_MAX_DAYS_PER_RUN,
    memoryCompactionMinEventsPerDay: parsed.MEMORY_COMPACTION_MIN_EVENTS_PER_DAY,
    memoryCompactionMaxEventsPerDay: parsed.MEMORY_COMPACTION_MAX_EVENTS_PER_DAY,
    memoryCompactionMaxNoteChars: parsed.MEMORY_COMPACTION_MAX_NOTE_CHARS,
    memoryCompactionSessionId: parsed.MEMORY_COMPACTION_SESSION_ID.trim() || "owner@s.whatsapp.net",
    heartbeatEnabled: parsed.HEARTBEAT_ENABLED,
    heartbeatIntervalMs: parsed.HEARTBEAT_INTERVAL_MS,
    heartbeatActiveHoursStart: parsed.HEARTBEAT_ACTIVE_HOURS_START,
    heartbeatActiveHoursEnd: parsed.HEARTBEAT_ACTIVE_HOURS_END,
    heartbeatRequireIdleQueue: parsed.HEARTBEAT_REQUIRE_IDLE_QUEUE,
    heartbeatDedupeWindowMs: parsed.HEARTBEAT_DEDUPE_WINDOW_MS,
    heartbeatSuppressOk: parsed.HEARTBEAT_SUPPRESS_OK,
    heartbeatSessionId: parsed.HEARTBEAT_SESSION_ID.trim() || "owner@s.whatsapp.net",
    heartbeatPendingNotificationAlertThreshold: parsed.HEARTBEAT_PENDING_NOTIFICATION_ALERT_THRESHOLD,
    heartbeatErrorLookbackMinutes: parsed.HEARTBEAT_ERROR_LOOKBACK_MINUTES,
    heartbeatAlertOnAuthDisconnected: parsed.HEARTBEAT_ALERT_ON_AUTH_DISCONNECTED,
    heartbeatAlertOnWhatsAppDisconnected: parsed.HEARTBEAT_ALERT_ON_WHATSAPP_DISCONNECTED,
    heartbeatAlertOnStuckJobs: parsed.HEARTBEAT_ALERT_ON_STUCK_JOBS,
    heartbeatStuckJobThresholdMinutes: parsed.HEARTBEAT_STUCK_JOB_THRESHOLD_MINUTES,
    streamMaxEvents: parsed.STREAM_MAX_EVENTS,
    streamRetentionDays: parsed.STREAM_RETENTION_DAYS,
    streamDedupeWindowMs: parsed.STREAM_DEDUPE_WINDOW_MS,
    publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    alfredWorkspaceDir: path.resolve(parsed.ALFRED_WORKSPACE_DIR),
    alfredApprovalMode: parsed.ALFRED_APPROVAL_MODE,
    alfredApprovalDefault: parsed.ALFRED_APPROVAL_DEFAULT,
    alfredPlannerEnabled: parsed.ALFRED_PLANNER_ENABLED,
    alfredPlannerMinConfidence: parsed.ALFRED_PLANNER_MIN_CONFIDENCE,
    alfredPlannerSystemFiles: parsed.ALFRED_PLANNER_SYSTEM_FILES.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    alfredWebSearchEnabled: parsed.ALFRED_WEB_SEARCH_ENABLED,
    alfredWebSearchRequireApproval: parsed.ALFRED_WEB_SEARCH_REQUIRE_APPROVAL,
    alfredWebSearchProvider: parsed.ALFRED_WEB_SEARCH_PROVIDER,
    alfredFileWriteEnabled: parsed.ALFRED_FILE_WRITE_ENABLED,
    alfredFileWriteRequireApproval: parsed.ALFRED_FILE_WRITE_REQUIRE_APPROVAL,
    alfredFileWriteNotesOnly: parsed.ALFRED_FILE_WRITE_NOTES_ONLY,
    alfredFileWriteNotesDir: parsed.ALFRED_FILE_WRITE_NOTES_DIR.trim() || "notes",
    alfredFileWriteApprovalMode: parsed.ALFRED_FILE_WRITE_APPROVAL_MODE,
    alfredFileWriteApprovalScope: parsed.ALFRED_FILE_WRITE_APPROVAL_SCOPE,
    alfredShellEnabled: parsed.ALFRED_SHELL_ENABLED,
    alfredShellTimeoutMs: parsed.ALFRED_SHELL_TIMEOUT_MS,
    alfredShellMaxOutputChars: parsed.ALFRED_SHELL_MAX_OUTPUT_CHARS,
    braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY,
    braveSearchUrl: parsed.BRAVE_SEARCH_URL,
    braveSearchTimeoutMs: parsed.BRAVE_SEARCH_TIMEOUT_MS,
    braveSearchMaxResults: parsed.BRAVE_SEARCH_MAX_RESULTS,
    searxngSearchUrl: parsed.SEARXNG_SEARCH_URL,
    searxngSearchTimeoutMs: parsed.SEARXNG_SEARCH_TIMEOUT_MS,
    searxngSearchMaxResults: parsed.SEARXNG_SEARCH_MAX_RESULTS,
    searxngSearchLanguage: parsed.SEARXNG_SEARCH_LANGUAGE.trim() || "en",
    searxngSearchSafeSearch: parsed.SEARXNG_SEARCH_SAFESEARCH,
    brightDataApiKey: parsed.BRIGHTDATA_API_KEY,
    brightDataSerpUrl: parsed.BRIGHTDATA_SERP_URL,
    brightDataZone: parsed.BRIGHTDATA_ZONE?.trim() || undefined,
    brightDataTimeoutMs: parsed.BRIGHTDATA_TIMEOUT_MS,
    brightDataMaxResults: parsed.BRIGHTDATA_MAX_RESULTS,
    perplexityApiKey: parsed.PERPLEXITY_API_KEY,
    perplexitySearchUrl: parsed.PERPLEXITY_SEARCH_URL,
    perplexityModel: parsed.PERPLEXITY_MODEL,
    perplexityTimeoutMs: parsed.PERPLEXITY_TIMEOUT_MS,
    oauthStateTtlMs: parsed.OAUTH_STATE_TTL_SEC * 1000,
    oauthTokenEncryptionKey: parsed.OAUTH_TOKEN_ENCRYPTION_KEY,
    oauthOpenAiMode: parsed.OAUTH_OPENAI_MODE,
    oauthOpenAiClientId: parsed.OAUTH_OPENAI_CLIENT_ID,
    oauthOpenAiClientSecret: parsed.OAUTH_OPENAI_CLIENT_SECRET,
    oauthOpenAiAuthorizeUrl: parsed.OAUTH_OPENAI_AUTHORIZE_URL,
    oauthOpenAiTokenUrl: parsed.OAUTH_OPENAI_TOKEN_URL,
    oauthOpenAiScope: parsed.OAUTH_OPENAI_SCOPE,
    openAiResponsesEnabled: parsed.OPENAI_RESPONSES_ENABLED,
    openAiResponsesUrl: parsed.OPENAI_RESPONSES_URL,
    openAiResponsesModel: parsed.OPENAI_RESPONSES_MODEL,
    openAiResponsesTimeoutMs: parsed.OPENAI_RESPONSES_TIMEOUT_MS,
    openAiApiKey: parsed.OPENAI_API_KEY,
    whatsAppProvider: parsed.WHATSAPP_PROVIDER,
    whatsAppBaileysAutoConnect: parsed.WHATSAPP_BAILEYS_AUTO_CONNECT,
    whatsAppBaileysAuthDir: path.resolve(parsed.WHATSAPP_BAILEYS_AUTH_DIR ?? path.join(parsed.STATE_DIR, "whatsapp", "baileys_auth")),
    whatsAppBaileysInboundToken: parsed.WHATSAPP_BAILEYS_INBOUND_TOKEN,
    whatsAppBaileysAllowSelfFromMe: parsed.WHATSAPP_BAILEYS_ALLOW_SELF_FROM_ME,
    whatsAppBaileysRequirePrefix: parsed.WHATSAPP_BAILEYS_REQUIRE_PREFIX.trim() || undefined,
    whatsAppBaileysAllowedSenders: (parsed.WHATSAPP_BAILEYS_ALLOWED_SENDERS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    whatsAppBaileysMaxTextChars: parsed.WHATSAPP_BAILEYS_MAX_TEXT_CHARS,
    whatsAppBaileysReconnectDelayMs: parsed.WHATSAPP_BAILEYS_RECONNECT_DELAY_MS,
    whatsAppBaileysMaxQrGenerations: parsed.WHATSAPP_BAILEYS_MAX_QR_GENERATIONS,
    codexAppServerEnabled: parsed.CODEX_APP_SERVER_ENABLED,
    codexAppServerCommand: parsed.CODEX_APP_SERVER_COMMAND,
    codexAppServerClientName: parsed.CODEX_APP_SERVER_CLIENT_NAME,
    codexAppServerClientVersion: parsed.CODEX_APP_SERVER_CLIENT_VERSION,
    codexAuthLoginMode: parsed.CODEX_AUTH_LOGIN_MODE,
    codexModel: parsed.CODEX_MODEL,
    codexTurnTimeoutMs: parsed.CODEX_TURN_TIMEOUT_MS,
    codexAccountRefreshBeforeTurn: parsed.CODEX_ACCOUNT_REFRESH_BEFORE_TURN
  };
}
