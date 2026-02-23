import { describe, expect, it } from "vitest";
import { CodexAuthService } from "../../apps/gateway-orchestrator/src/codex/auth_service";

describe("CodexAuthService", () => {
  it("maps chatgpt account status and login start response", async () => {
    const fakeClient = {
      ensureStarted: async () => undefined,
      onNotification: () => () => undefined,
      setChatgptAuthTokensRefreshHandler: () => undefined,
      stop: async () => undefined,
      request: async (method: string) => {
        if (method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "plus"
            },
            requiresOpenaiAuth: true
          };
        }
        if (method === "account/login/start") {
          return {
            type: "chatgpt",
            loginId: "login-123",
            authUrl: "https://chatgpt.com/oauth/start"
          };
        }
        if (method === "account/rateLimits/read") {
          return {
            rateLimits: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 12.5, windowDurationMins: 60, resetsAt: 1_700_000_000 },
              secondary: null,
              credits: null,
              planType: "plus"
            },
            rateLimitsByLimitId: null
          };
        }
        return {};
      }
    } as const;

    const auth = new CodexAuthService(fakeClient as never);
    const status = await auth.readStatus();
    expect(status.connected).toBe(true);
    expect(status.authMode).toBe("chatgpt");
    expect(status.email).toBe("user@example.com");

    const started = await auth.startLogin("chatgpt");
    expect(started.authorizationUrl).toContain("chatgpt.com");
    expect(started.loginId).toBe("login-123");

    const limits = await auth.readRateLimits();
    expect(limits.rateLimits.limitId).toBe("codex");
  });

  it("returns disconnected state when account is missing", async () => {
    const fakeClient = {
      ensureStarted: async () => undefined,
      onNotification: () => () => undefined,
      setChatgptAuthTokensRefreshHandler: () => undefined,
      stop: async () => undefined,
      request: async (method: string) => {
        if (method === "account/read") {
          return {
            account: null,
            requiresOpenaiAuth: true
          };
        }
        return {};
      }
    } as const;

    const auth = new CodexAuthService(fakeClient as never);
    const status = await auth.readStatus();
    expect(status.connected).toBe(false);
    expect(status.authMode).toBeNull();
  });
});
