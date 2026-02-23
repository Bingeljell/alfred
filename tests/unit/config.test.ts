import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/gateway-orchestrator/src/config";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.workerPollMs).toBe(250);
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.oauthOpenAiMode).toBe("mock");
    expect(config.openAiResponsesEnabled).toBe(true);
    expect(config.openAiResponsesUrl).toBe("https://api.openai.com/v1/responses");
    expect(config.openAiResponsesModel).toBe("gpt-4.1-mini");
    expect(config.stateDir.length).toBeGreaterThan(0);
  });

  it("parses custom env values", () => {
    const config = loadConfig({
      PORT: "4010",
      STATE_DIR: "./tmp/state-a",
      WORKER_POLL_MS: "500",
      PUBLIC_BASE_URL: "http://localhost:4010/",
      OAUTH_OPENAI_MODE: "live",
      OAUTH_OPENAI_CLIENT_ID: "client",
      OAUTH_OPENAI_TOKEN_URL: "https://example.test/token",
      OPENAI_RESPONSES_ENABLED: "false",
      OPENAI_RESPONSES_MODEL: "gpt-4.1",
      OPENAI_RESPONSES_TIMEOUT_MS: "7000"
    });

    expect(config.port).toBe(4010);
    expect(config.workerPollMs).toBe(500);
    expect(config.publicBaseUrl).toBe("http://localhost:4010");
    expect(config.oauthOpenAiMode).toBe("live");
    expect(config.oauthOpenAiClientId).toBe("client");
    expect(config.openAiResponsesEnabled).toBe(false);
    expect(config.openAiResponsesModel).toBe("gpt-4.1");
    expect(config.openAiResponsesTimeoutMs).toBe(7000);
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
