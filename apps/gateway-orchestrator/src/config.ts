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
  PUBLIC_BASE_URL: z.string().optional().default("http://localhost:3000"),
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
  notificationPollMs: number;
  reminderPollMs: number;
  publicBaseUrl: string;
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
    notificationPollMs: parsed.NOTIFICATION_POLL_MS,
    reminderPollMs: parsed.REMINDER_POLL_MS,
    publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/+$/, ""),
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
