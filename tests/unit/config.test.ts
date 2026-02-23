import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/gateway-orchestrator/src/config";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.workerPollMs).toBe(250);
    expect(config.streamMaxEvents).toBe(5000);
    expect(config.streamRetentionDays).toBe(14);
    expect(config.streamDedupeWindowMs).toBe(2500);
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
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
      STREAM_MAX_EVENTS: "8000",
      STREAM_RETENTION_DAYS: "30",
      STREAM_DEDUPE_WINDOW_MS: "1200",
      PUBLIC_BASE_URL: "http://localhost:4010/",
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
    expect(config.streamMaxEvents).toBe(8000);
    expect(config.streamRetentionDays).toBe(30);
    expect(config.streamDedupeWindowMs).toBe(1200);
    expect(config.publicBaseUrl).toBe("http://localhost:4010");
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
