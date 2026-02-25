import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/gateway-orchestrator/src/config";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.workerPollMs).toBe(250);
    expect(config.heartbeatEnabled).toBe(true);
    expect(config.heartbeatIntervalMs).toBe(1800000);
    expect(config.heartbeatActiveHoursStart).toBe(9);
    expect(config.heartbeatActiveHoursEnd).toBe(22);
    expect(config.heartbeatRequireIdleQueue).toBe(true);
    expect(config.heartbeatDedupeWindowMs).toBe(7200000);
    expect(config.heartbeatSuppressOk).toBe(true);
    expect(config.heartbeatSessionId).toBe("owner@s.whatsapp.net");
    expect(config.heartbeatPendingNotificationAlertThreshold).toBe(5);
    expect(config.heartbeatErrorLookbackMinutes).toBe(120);
    expect(config.heartbeatAlertOnAuthDisconnected).toBe(true);
    expect(config.heartbeatAlertOnWhatsAppDisconnected).toBe(true);
    expect(config.heartbeatAlertOnStuckJobs).toBe(true);
    expect(config.heartbeatStuckJobThresholdMinutes).toBe(30);
    expect(config.streamMaxEvents).toBe(5000);
    expect(config.streamRetentionDays).toBe(14);
    expect(config.streamDedupeWindowMs).toBe(2500);
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.alfredWorkspaceDir.endsWith("workspace/alfred")).toBe(true);
    expect(config.alfredApprovalDefault).toBe(true);
    expect(config.alfredWebSearchEnabled).toBe(true);
    expect(config.alfredWebSearchRequireApproval).toBe(true);
    expect(config.alfredWebSearchProvider).toBe("openai");
    expect(config.alfredFileWriteEnabled).toBe(false);
    expect(config.alfredFileWriteRequireApproval).toBe(true);
    expect(config.alfredFileWriteNotesOnly).toBe(true);
    expect(config.alfredFileWriteNotesDir).toBe("notes");
    expect(config.braveSearchApiKey).toBeUndefined();
    expect(config.braveSearchUrl).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(config.braveSearchTimeoutMs).toBe(12000);
    expect(config.braveSearchMaxResults).toBe(5);
    expect(config.perplexityApiKey).toBeUndefined();
    expect(config.perplexitySearchUrl).toBe("https://api.perplexity.ai/chat/completions");
    expect(config.perplexityModel).toBe("sonar");
    expect(config.perplexityTimeoutMs).toBe(20000);
    expect(config.oauthOpenAiMode).toBe("mock");
    expect(config.openAiResponsesEnabled).toBe(true);
    expect(config.openAiResponsesUrl).toBe("https://api.openai.com/v1/responses");
    expect(config.openAiResponsesModel).toBe("gpt-4.1-mini");
    expect(config.whatsAppProvider).toBe("stdout");
    expect(config.whatsAppBaileysAutoConnect).toBe(false);
    expect(config.whatsAppBaileysAllowSelfFromMe).toBe(false);
    expect(config.whatsAppBaileysRequirePrefix).toBe("/alfred");
    expect(config.whatsAppBaileysAllowedSenders).toEqual([]);
    expect(config.whatsAppBaileysMaxTextChars).toBe(4000);
    expect(config.whatsAppBaileysMaxQrGenerations).toBe(3);
    expect(config.codexAppServerEnabled).toBe(false);
    expect(config.codexAuthLoginMode).toBe("chatgpt");
    expect(config.stateDir.length).toBeGreaterThan(0);
  });

  it("parses custom env values", () => {
    const config = loadConfig({
      PORT: "4010",
      STATE_DIR: "./tmp/state-a",
      WORKER_POLL_MS: "500",
      HEARTBEAT_ENABLED: "false",
      HEARTBEAT_INTERVAL_MS: "45000",
      HEARTBEAT_ACTIVE_HOURS_START: "7",
      HEARTBEAT_ACTIVE_HOURS_END: "20",
      HEARTBEAT_REQUIRE_IDLE_QUEUE: "false",
      HEARTBEAT_DEDUPE_WINDOW_MS: "600000",
      HEARTBEAT_SUPPRESS_OK: "false",
      HEARTBEAT_SESSION_ID: "heartbeat@test.session",
      HEARTBEAT_PENDING_NOTIFICATION_ALERT_THRESHOLD: "9",
      HEARTBEAT_ERROR_LOOKBACK_MINUTES: "45",
      HEARTBEAT_ALERT_ON_AUTH_DISCONNECTED: "false",
      HEARTBEAT_ALERT_ON_WHATSAPP_DISCONNECTED: "false",
      HEARTBEAT_ALERT_ON_STUCK_JOBS: "false",
      HEARTBEAT_STUCK_JOB_THRESHOLD_MINUTES: "75",
      STREAM_MAX_EVENTS: "8000",
      STREAM_RETENTION_DAYS: "30",
      STREAM_DEDUPE_WINDOW_MS: "1200",
      PUBLIC_BASE_URL: "http://localhost:4010/",
      ALFRED_WORKSPACE_DIR: "./tmp/alfred-workspace",
      ALFRED_APPROVAL_DEFAULT: "false",
      ALFRED_WEB_SEARCH_ENABLED: "false",
      ALFRED_WEB_SEARCH_REQUIRE_APPROVAL: "false",
      ALFRED_WEB_SEARCH_PROVIDER: "brave",
      ALFRED_FILE_WRITE_ENABLED: "true",
      ALFRED_FILE_WRITE_REQUIRE_APPROVAL: "false",
      ALFRED_FILE_WRITE_NOTES_ONLY: "false",
      ALFRED_FILE_WRITE_NOTES_DIR: "scratch",
      BRAVE_SEARCH_API_KEY: "brave-key",
      BRAVE_SEARCH_URL: "https://brave.example/search",
      BRAVE_SEARCH_TIMEOUT_MS: "9000",
      BRAVE_SEARCH_MAX_RESULTS: "7",
      PERPLEXITY_API_KEY: "px-key",
      PERPLEXITY_SEARCH_URL: "https://perplexity.example/chat",
      PERPLEXITY_MODEL: "sonar-pro",
      PERPLEXITY_TIMEOUT_MS: "19000",
      OAUTH_OPENAI_MODE: "live",
      OAUTH_OPENAI_CLIENT_ID: "client",
      OAUTH_OPENAI_TOKEN_URL: "https://example.test/token",
      OPENAI_RESPONSES_ENABLED: "false",
      OPENAI_RESPONSES_MODEL: "gpt-4.1",
      OPENAI_RESPONSES_TIMEOUT_MS: "7000",
      WHATSAPP_PROVIDER: "baileys",
      WHATSAPP_BAILEYS_AUTO_CONNECT: "true",
      WHATSAPP_BAILEYS_AUTH_DIR: "./tmp/wa-auth",
      WHATSAPP_BAILEYS_INBOUND_TOKEN: "secret-token",
      WHATSAPP_BAILEYS_ALLOW_SELF_FROM_ME: "true",
      WHATSAPP_BAILEYS_REQUIRE_PREFIX: "/bot",
      WHATSAPP_BAILEYS_ALLOWED_SENDERS: "111@s.whatsapp.net,222@s.whatsapp.net",
      WHATSAPP_BAILEYS_MAX_TEXT_CHARS: "2048",
      WHATSAPP_BAILEYS_RECONNECT_DELAY_MS: "2500",
      WHATSAPP_BAILEYS_MAX_QR_GENERATIONS: "5",
      CODEX_APP_SERVER_ENABLED: "true",
      CODEX_APP_SERVER_COMMAND: "codex",
      CODEX_AUTH_LOGIN_MODE: "apiKey",
      CODEX_MODEL: "openai-codex/mini",
      CODEX_TURN_TIMEOUT_MS: "45000"
    });

    expect(config.port).toBe(4010);
    expect(config.workerPollMs).toBe(500);
    expect(config.heartbeatEnabled).toBe(false);
    expect(config.heartbeatIntervalMs).toBe(45000);
    expect(config.heartbeatActiveHoursStart).toBe(7);
    expect(config.heartbeatActiveHoursEnd).toBe(20);
    expect(config.heartbeatRequireIdleQueue).toBe(false);
    expect(config.heartbeatDedupeWindowMs).toBe(600000);
    expect(config.heartbeatSuppressOk).toBe(false);
    expect(config.heartbeatSessionId).toBe("heartbeat@test.session");
    expect(config.heartbeatPendingNotificationAlertThreshold).toBe(9);
    expect(config.heartbeatErrorLookbackMinutes).toBe(45);
    expect(config.heartbeatAlertOnAuthDisconnected).toBe(false);
    expect(config.heartbeatAlertOnWhatsAppDisconnected).toBe(false);
    expect(config.heartbeatAlertOnStuckJobs).toBe(false);
    expect(config.heartbeatStuckJobThresholdMinutes).toBe(75);
    expect(config.streamMaxEvents).toBe(8000);
    expect(config.streamRetentionDays).toBe(30);
    expect(config.streamDedupeWindowMs).toBe(1200);
    expect(config.publicBaseUrl).toBe("http://localhost:4010");
    expect(config.alfredWorkspaceDir.endsWith("tmp/alfred-workspace")).toBe(true);
    expect(config.alfredApprovalDefault).toBe(false);
    expect(config.alfredWebSearchEnabled).toBe(false);
    expect(config.alfredWebSearchRequireApproval).toBe(false);
    expect(config.alfredWebSearchProvider).toBe("brave");
    expect(config.alfredFileWriteEnabled).toBe(true);
    expect(config.alfredFileWriteRequireApproval).toBe(false);
    expect(config.alfredFileWriteNotesOnly).toBe(false);
    expect(config.alfredFileWriteNotesDir).toBe("scratch");
    expect(config.braveSearchApiKey).toBe("brave-key");
    expect(config.braveSearchUrl).toBe("https://brave.example/search");
    expect(config.braveSearchTimeoutMs).toBe(9000);
    expect(config.braveSearchMaxResults).toBe(7);
    expect(config.perplexityApiKey).toBe("px-key");
    expect(config.perplexitySearchUrl).toBe("https://perplexity.example/chat");
    expect(config.perplexityModel).toBe("sonar-pro");
    expect(config.perplexityTimeoutMs).toBe(19000);
    expect(config.oauthOpenAiMode).toBe("live");
    expect(config.oauthOpenAiClientId).toBe("client");
    expect(config.openAiResponsesEnabled).toBe(false);
    expect(config.openAiResponsesModel).toBe("gpt-4.1");
    expect(config.openAiResponsesTimeoutMs).toBe(7000);
    expect(config.whatsAppProvider).toBe("baileys");
    expect(config.whatsAppBaileysAutoConnect).toBe(true);
    expect(config.whatsAppBaileysAuthDir.endsWith("tmp/wa-auth")).toBe(true);
    expect(config.whatsAppBaileysInboundToken).toBe("secret-token");
    expect(config.whatsAppBaileysAllowSelfFromMe).toBe(true);
    expect(config.whatsAppBaileysRequirePrefix).toBe("/bot");
    expect(config.whatsAppBaileysAllowedSenders).toEqual(["111@s.whatsapp.net", "222@s.whatsapp.net"]);
    expect(config.whatsAppBaileysMaxTextChars).toBe(2048);
    expect(config.whatsAppBaileysReconnectDelayMs).toBe(2500);
    expect(config.whatsAppBaileysMaxQrGenerations).toBe(5);
    expect(config.codexAppServerEnabled).toBe(true);
    expect(config.codexAuthLoginMode).toBe("apiKey");
    expect(config.codexModel).toBe("openai-codex/mini");
    expect(config.codexTurnTimeoutMs).toBe(45000);
    expect(config.stateDir.endsWith("tmp/state-a")).toBe(true);
  });

  it("fails on invalid values", () => {
    expect(() =>
      loadConfig({
        PORT: "99999"
      })
    ).toThrow();
  });
});
