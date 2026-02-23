import {
  CodexAppServerClient,
  type AppServerNotification,
  type ChatgptTokensRefreshResponse
} from "./app_server_client";
import { CodexAuthStateStore, type CodexAuthTelemetry } from "./auth_state_store";

export type CodexLoginStartMode = "chatgpt" | "chatgptAuthTokens" | "apiKey";

export type CodexAuthStatus = {
  connected: boolean;
  authMode: "chatgpt" | "apiKey" | "chatgptAuthTokens" | null;
  email?: string;
  planType?: string;
  requiresOpenaiAuth: boolean;
};

type AccountReadResponse = {
  account: { type: "chatgpt"; email: string; planType: string } | { type: "apiKey" } | null;
  requiresOpenaiAuth: boolean;
};

type AccountLoginStartResult =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptAuthTokens";
    };

type RateLimitsResult = {
  rateLimits: {
    limitId: string | null;
    limitName: string | null;
    primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
    secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
    credits: unknown;
    planType: string | null;
  };
  rateLimitsByLimitId?: Record<string, unknown> | null;
};

export class CodexAuthService {
  private readonly client: CodexAppServerClient;
  private readonly stateStore?: CodexAuthStateStore;
  private lastLoginCompleted: { loginId: string | null; success: boolean; error: string | null } | null = null;

  constructor(client: CodexAppServerClient, options?: { stateStore?: CodexAuthStateStore }) {
    this.client = client;
    this.stateStore = options?.stateStore;
    this.client.onNotification((event) => {
      this.onNotification(event);
    });
  }

  async ensureReady(): Promise<void> {
    if (this.stateStore) {
      await this.stateStore.ensureReady();
    }
    await this.client.ensureStarted();
  }

  setChatgptAuthTokensRefreshHandler(
    handler: (reason: string, previousAccountId?: string | null) => Promise<ChatgptTokensRefreshResponse | null>
  ): void {
    this.client.setChatgptAuthTokensRefreshHandler(handler);
  }

  async readStatus(refreshToken = false): Promise<CodexAuthStatus> {
    try {
      const result = await this.client.request<AccountReadResponse>("account/read", { refreshToken });
      let status: CodexAuthStatus;
      if (!result.account) {
        status = {
          connected: false,
          authMode: null,
          requiresOpenaiAuth: result.requiresOpenaiAuth
        };
      } else if (result.account.type === "chatgpt") {
        status = {
          connected: true,
          authMode: "chatgpt",
          email: result.account.email,
          planType: result.account.planType,
          requiresOpenaiAuth: result.requiresOpenaiAuth
        };
      } else {
        status = {
          connected: true,
          authMode: "apiKey",
          requiresOpenaiAuth: result.requiresOpenaiAuth
        };
      }

      if (this.stateStore) {
        await this.stateStore.recordStatusSnapshot(status);
      }
      return status;
    } catch (error) {
      if (this.stateStore) {
        await this.stateStore.recordStatusError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async startLogin(mode: CodexLoginStartMode, apiKey?: string): Promise<{
    mode: CodexLoginStartMode;
    loginId?: string;
    authorizationUrl?: string;
  }> {
    if (mode === "apiKey") {
      if (!apiKey?.trim()) {
        throw new Error("codex_api_key_required");
      }

      await this.client.request<AccountLoginStartResult>("account/login/start", {
        type: "apiKey",
        apiKey: apiKey.trim()
      });

      return {
        mode: "apiKey"
      };
    }

    if (mode === "chatgpt") {
      const result = await this.client.request<AccountLoginStartResult>("account/login/start", {
        type: "chatgpt"
      });

      if (result.type !== "chatgpt") {
        throw new Error("codex_login_chatgpt_unexpected_response");
      }

      return {
        mode: "chatgpt",
        loginId: result.loginId,
        authorizationUrl: result.authUrl
      };
    }

    throw new Error("chatgptAuthTokens_mode_not_implemented");
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.client.request("account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.client.request("account/logout");
    if (this.stateStore) {
      await this.stateStore.recordDisconnect();
    }
  }

  async readRateLimits(): Promise<RateLimitsResult> {
    return this.client.request<RateLimitsResult>("account/rateLimits/read");
  }

  lastLoginResult(): { loginId: string | null; success: boolean; error: string | null } | null {
    return this.lastLoginCompleted;
  }

  async telemetry(): Promise<CodexAuthTelemetry | null> {
    if (!this.stateStore) {
      return null;
    }
    return this.stateStore.readTelemetry();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  private onNotification(event: AppServerNotification): void {
    if (event.method !== "account/login/completed") {
      return;
    }

    const params = (event.params ?? {}) as {
      loginId?: string | null;
      success?: boolean;
      error?: string | null;
    };

    this.lastLoginCompleted = {
      loginId: params.loginId ?? null,
      success: Boolean(params.success),
      error: typeof params.error === "string" ? params.error : null
    };

    if (this.stateStore) {
      void this.stateStore.recordLogin(this.lastLoginCompleted);
    }
  }
}
