import { randomUUID } from "node:crypto";
import { OAuthSecretCodec } from "./oauth_codec";
import { OAuthStore, type OAuthProvider } from "./oauth_store";

export type OAuthMode = "mock" | "live";

type OpenAiOAuthConfig = {
  mode: OAuthMode;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scope?: string;
};

type OAuthTokenPayload = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: string;
  obtainedAt: string;
};

export type OAuthConnectionStatus = {
  provider: OAuthProvider;
  sessionId: string;
  connected: boolean;
  mode: OAuthMode;
  expiresAt?: string;
  updatedAt?: string;
  scope?: string;
  storageScheme: "plain" | "aes-256-gcm";
};

export type OAuthStartResult = {
  provider: OAuthProvider;
  sessionId: string;
  mode: OAuthMode;
  state: string;
  authorizationUrl: string;
};

export class OAuthService {
  private readonly store: OAuthStore;
  private readonly codec: OAuthSecretCodec;
  private readonly openai: OpenAiOAuthConfig;
  private readonly publicBaseUrl: string;
  private readonly stateTtlMs: number;

  constructor(options: {
    stateDir: string;
    publicBaseUrl: string;
    encryptionKey?: string;
    stateTtlMs?: number;
    openai: OpenAiOAuthConfig;
  }) {
    this.store = new OAuthStore(options.stateDir);
    this.codec = new OAuthSecretCodec(options.encryptionKey);
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000;
    this.openai = options.openai;
  }

  async ensureReady(): Promise<void> {
    await this.store.ensureReady();
  }

  getOpenAiMode(): OAuthMode {
    return this.openai.mode;
  }

  async startOpenAiConnect(sessionId: string): Promise<OAuthStartResult> {
    const state = randomUUID().replaceAll("-", "");
    const now = Date.now();
    const redirectUri = this.callbackUrl();
    await this.store.addPending({
      state,
      sessionId,
      provider: "openai",
      redirectUri,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.stateTtlMs).toISOString()
    });

    const authorizationUrl =
      this.openai.mode === "mock"
        ? `${this.publicBaseUrl}/v1/auth/openai/mock/authorize?state=${encodeURIComponent(state)}`
        : this.buildOpenAiAuthorizeUrl(state, redirectUri);

    return {
      provider: "openai",
      sessionId,
      mode: this.openai.mode,
      state,
      authorizationUrl
    };
  }

  async completeOpenAiCallback(input: { state: string; code?: string; error?: string }): Promise<OAuthConnectionStatus> {
    if (input.error) {
      throw new Error(`oauth_callback_error:${input.error}`);
    }

    if (!input.code) {
      throw new Error("oauth_callback_missing_code");
    }

    const pending = await this.store.consumePending("openai", input.state);
    if (!pending) {
      throw new Error("oauth_state_invalid_or_expired");
    }

    const tokenPayload =
      this.openai.mode === "mock"
        ? this.mockTokenPayload(input.code)
        : await this.exchangeOpenAiCode(input.code, pending.redirectUri);

    const now = new Date().toISOString();
    await this.store.upsertToken({
      provider: "openai",
      sessionId: pending.sessionId,
      secret: this.codec.encode(JSON.stringify(tokenPayload)),
      createdAt: now,
      updatedAt: now,
      expiresAt: tokenPayload.expiresAt,
      scope: tokenPayload.scope
    });

    return {
      provider: "openai",
      sessionId: pending.sessionId,
      connected: true,
      mode: this.openai.mode,
      expiresAt: tokenPayload.expiresAt,
      updatedAt: now,
      scope: tokenPayload.scope,
      storageScheme: this.codec.storageScheme()
    };
  }

  async statusOpenAi(sessionId: string): Promise<OAuthConnectionStatus> {
    const token = await this.store.getToken("openai", sessionId);
    if (!token) {
      return {
        provider: "openai",
        sessionId,
        connected: false,
        mode: this.openai.mode,
        storageScheme: this.codec.storageScheme()
      };
    }

    return {
      provider: "openai",
      sessionId,
      connected: true,
      mode: this.openai.mode,
      expiresAt: token.expiresAt,
      updatedAt: token.updatedAt,
      scope: token.scope,
      storageScheme: token.secret.scheme
    };
  }

  async disconnectOpenAi(sessionId: string): Promise<boolean> {
    return this.store.deleteToken("openai", sessionId);
  }

  async hasPendingOpenAiState(state: string): Promise<boolean> {
    return this.store.hasPending("openai", state);
  }

  renderMockAuthorizePage(state: string): string {
    const callback = this.callbackUrl();
    const allowUrl = `${callback}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`mock-${Date.now()}`)}`;
    const denyUrl = `${callback}?state=${encodeURIComponent(state)}&error=access_denied`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenAI OAuth (Mock)</title>
    <style>
      body { font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background: #f4f6f8; color: #1f2937; margin: 0; }
      main { max-width: 680px; margin: 50px auto; background: #ffffff; border: 1px solid #d1d5db; border-radius: 12px; padding: 20px; }
      h1 { margin-top: 0; font-size: 22px; }
      p { color: #4b5563; }
      .actions { display: flex; gap: 10px; margin-top: 16px; }
      a { text-decoration: none; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 8px; font-weight: 600; }
      a.allow { background: #dcfce7; color: #14532d; border-color: #86efac; }
      a.deny { background: #fee2e2; color: #7f1d1d; border-color: #fca5a5; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>OpenAI OAuth Mock Consent</h1>
      <p>This is a local-only mock page for testing OAuth flow end-to-end.</p>
      <p>State: <code>${state}</code></p>
      <div class="actions">
        <a class="allow" href="${allowUrl}">Allow</a>
        <a class="deny" href="${denyUrl}">Deny</a>
      </div>
    </main>
  </body>
</html>`;
  }

  private callbackUrl(): string {
    return `${this.publicBaseUrl}/v1/auth/openai/callback`;
  }

  private mockTokenPayload(code: string): OAuthTokenPayload {
    const nowMs = Date.now();
    return {
      accessToken: `mock_access_${code}`,
      refreshToken: `mock_refresh_${code}`,
      tokenType: "Bearer",
      scope: this.openai.scope ?? "responses.read responses.write",
      expiresAt: new Date(nowMs + 3600 * 1000).toISOString(),
      obtainedAt: new Date(nowMs).toISOString()
    };
  }

  private buildOpenAiAuthorizeUrl(state: string, redirectUri: string): string {
    if (!this.openai.authorizeUrl || !this.openai.clientId) {
      throw new Error("oauth_openai_live_missing_authorize_config");
    }

    const url = new URL(this.openai.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.openai.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.openai.scope ?? "offline_access");
    url.searchParams.set("state", state);
    return url.toString();
  }

  private async exchangeOpenAiCode(code: string, redirectUri: string): Promise<OAuthTokenPayload> {
    if (!this.openai.tokenUrl || !this.openai.clientId || !this.openai.clientSecret) {
      throw new Error("oauth_openai_live_missing_token_config");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.openai.clientId,
      client_secret: this.openai.clientSecret,
      redirect_uri: redirectUri
    });

    const response = await fetch(this.openai.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      throw new Error(`oauth_token_exchange_failed:${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!accessToken) {
      throw new Error("oauth_token_exchange_missing_access_token");
    }

    const nowMs = Date.now();
    const expiresInRaw = payload.expires_in;
    const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : Number(expiresInRaw ?? NaN);
    const expiresAt = Number.isFinite(expiresIn) ? new Date(nowMs + expiresIn * 1000).toISOString() : undefined;

    return {
      accessToken,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
      expiresAt,
      obtainedAt: new Date(nowMs).toISOString()
    };
  }
}
