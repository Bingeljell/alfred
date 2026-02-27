import type { Express } from "express";
import { z } from "zod";

const SessionBodySchema = z.object({
  sessionId: z.string().min(1)
});

const CallbackQuerySchema = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional()
});

type CodexAuthServiceLike = {
  startLogin: (
    mode: "chatgpt" | "chatgptAuthTokens" | "apiKey",
    apiKey?: string
  ) => Promise<{ mode: "chatgpt" | "chatgptAuthTokens" | "apiKey"; loginId?: string; authorizationUrl?: string }>;
  readStatus: (refreshBeforeRead?: boolean) => Promise<Record<string, unknown>>;
  telemetry: () => Promise<Record<string, unknown> | null>;
  lastLoginResult: () => unknown;
  logout: () => Promise<void>;
  readRateLimits: () => Promise<unknown>;
};

type OAuthServiceLike = {
  startOpenAiConnect: (sessionId: string) => Promise<unknown>;
  statusOpenAi: (sessionId: string) => Promise<unknown>;
  disconnectOpenAi: (sessionId: string) => Promise<boolean>;
  completeOpenAiCallback: (query: { state: string; code?: string; error?: string }) => Promise<{ sessionId: string }>;
  getOpenAiMode: () => string;
  hasPendingOpenAiState: (state: string) => Promise<boolean>;
  renderMockAuthorizePage: (state: string) => string;
};

export function registerAuthRoutes(
  app: Express,
  deps: {
    oauthService?: OAuthServiceLike;
    codexAuthService?: CodexAuthServiceLike;
    codexLoginMode?: "chatgpt" | "chatgptAuthTokens" | "apiKey";
    codexApiKey?: string;
  }
) {
  app.post("/v1/auth/openai/start", async (req, res) => {
    if (deps.codexAuthService) {
      try {
        const input = SessionBodySchema.parse(req.body ?? {});
        const started = await deps.codexAuthService.startLogin(deps.codexLoginMode ?? "chatgpt", deps.codexApiKey);
        res.status(200).json({
          provider: "openai-codex",
          mode: started.mode,
          sessionId: input.sessionId,
          loginId: started.loginId,
          authorizationUrl: started.authorizationUrl
        });
      } catch (error) {
        res.status(400).json({ error: "codex_auth_start_failed", detail: String(error) });
      }
      return;
    }

    if (!deps.oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    try {
      const input = SessionBodySchema.parse(req.body ?? {});
      const started = await deps.oauthService.startOpenAiConnect(input.sessionId);
      res.status(200).json(started);
    } catch (error) {
      res.status(400).json({ error: "invalid_oauth_start_request", detail: String(error) });
    }
  });

  app.get("/v1/auth/openai/status", async (req, res) => {
    if (deps.codexAuthService) {
      try {
        const status = await deps.codexAuthService.readStatus(false);
        const telemetry = await deps.codexAuthService.telemetry();
        const lastLogin = telemetry?.lastLogin ?? deps.codexAuthService.lastLoginResult();
        res.status(200).json({
          provider: "openai-codex",
          ...status,
          lastLogin,
          telemetry
        });
      } catch (error) {
        res.status(400).json({ error: "codex_auth_status_failed", detail: String(error) });
      }
      return;
    }

    if (!deps.oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const status = await deps.oauthService.statusOpenAi(sessionId);
    res.status(200).json(status);
  });

  app.post("/v1/auth/openai/disconnect", async (req, res) => {
    if (deps.codexAuthService) {
      try {
        const input = SessionBodySchema.parse(req.body ?? {});
        await deps.codexAuthService.logout();
        res.status(200).json({ disconnected: true, sessionId: input.sessionId, provider: "openai-codex" });
      } catch (error) {
        res.status(400).json({ error: "codex_auth_disconnect_failed", detail: String(error) });
      }
      return;
    }

    if (!deps.oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    try {
      const input = SessionBodySchema.parse(req.body ?? {});
      const removed = await deps.oauthService.disconnectOpenAi(input.sessionId);
      res.status(200).json({ disconnected: removed, sessionId: input.sessionId, provider: "openai" });
    } catch (error) {
      res.status(400).json({ error: "invalid_oauth_disconnect_request", detail: String(error) });
    }
  });

  app.get("/v1/auth/openai/callback", async (req, res) => {
    if (!deps.oauthService) {
      res.status(404).type("html").send("<h1>OAuth not configured</h1>");
      return;
    }

    try {
      const query = CallbackQuerySchema.parse(req.query ?? {});
      const completed = await deps.oauthService.completeOpenAiCallback(query);
      res
        .status(200)
        .type("html")
        .send(
          `<html><body><h1>OAuth connected</h1><p>Session: ${completed.sessionId}</p><p>Provider: openai</p><p>You can close this tab.</p></body></html>`
        );
    } catch (error) {
      res
        .status(400)
        .type("html")
        .send(`<html><body><h1>OAuth failed</h1><p>${String(error)}</p><p>You can return to the console.</p></body></html>`);
    }
  });

  app.get("/v1/auth/openai/rate-limits", async (_req, res) => {
    if (!deps.codexAuthService) {
      res.status(404).json({ error: "codex_auth_not_configured" });
      return;
    }

    try {
      const limits = await deps.codexAuthService.readRateLimits();
      res.status(200).json(limits);
    } catch (error) {
      res.status(400).json({ error: "codex_rate_limits_failed", detail: String(error) });
    }
  });

  app.get("/v1/auth/openai/mock/authorize", async (req, res) => {
    if (!deps.oauthService || deps.oauthService.getOpenAiMode() !== "mock") {
      res.status(404).type("html").send("<h1>Mock OAuth mode is disabled</h1>");
      return;
    }

    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) {
      res.status(400).type("html").send("<h1>Missing state</h1>");
      return;
    }

    const exists = await deps.oauthService.hasPendingOpenAiState(state);
    if (!exists) {
      res.status(400).type("html").send("<h1>Invalid or expired OAuth state</h1>");
      return;
    }

    res.status(200).type("html").send(deps.oauthService.renderMockAuthorizePage(state));
  });
}
