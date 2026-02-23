import express from "express";
import { z } from "zod";
import { FileBackedQueueStore } from "./local_queue_store";
import { GatewayService } from "./gateway_service";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { OutboundNotificationStore } from "./notification_store";
import { MemoryService } from "../../../packages/memory/src";
import { ReminderStore } from "./builtins/reminder_store";
import { NoteStore } from "./builtins/note_store";
import { TaskStore } from "./builtins/task_store";
import { ApprovalStore } from "./builtins/approval_store";
import { renderWebConsoleHtml } from "./ui/render_web_console";
import { OAuthService } from "./auth/oauth_service";
import { OpenAIResponsesService } from "./llm/openai_responses_service";

const CancelParamsSchema = z.object({
  jobId: z.string().min(1)
});

const SessionBodySchema = z.object({
  sessionId: z.string().min(1)
});

const CallbackQuerySchema = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional()
});

export function createGatewayApp(
  store: FileBackedQueueStore,
  options?: {
    dedupeStore?: MessageDedupeStore;
    notificationStore?: OutboundNotificationStore;
    memoryService?: MemoryService;
    reminderStore?: ReminderStore;
    noteStore?: NoteStore;
    taskStore?: TaskStore;
    approvalStore?: ApprovalStore;
    oauthService?: OAuthService;
    llmService?: OpenAIResponsesService;
  }
) {
  const app = express();
  const service = new GatewayService(
    store,
    options?.notificationStore,
    options?.reminderStore,
    options?.noteStore,
    options?.taskStore,
    options?.approvalStore,
    options?.oauthService,
    options?.llmService
  );
  const dedupeStore = options?.dedupeStore ?? new MessageDedupeStore(process.cwd());
  const memoryService = options?.memoryService;
  const oauthService = options?.oauthService;
  void dedupeStore.ensureReady();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.redirect(302, "/ui");
  });

  app.get("/ui", (_req, res) => {
    res.status(200).type("html").send(renderWebConsoleHtml());
  });

  app.get("/health", async (_req, res) => {
    const health = await service.health();
    res.status(200).json(health);
  });

  app.post("/v1/messages/inbound", async (req, res) => {
    try {
      const result = await service.handleInbound(req.body);
      res.status(result.mode === "async-job" ? 202 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_inbound_message", detail: String(error) });
    }
  });

  app.post("/v1/whatsapp/baileys/inbound", async (req, res) => {
    try {
      const result = await service.handleBaileysInbound(req.body, dedupeStore);
      if (result.duplicate) {
        res.status(200).json(result);
        return;
      }
      res.status(result.mode === "async-job" ? 202 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_baileys_inbound", detail: String(error) });
    }
  });

  app.post("/v1/jobs", async (req, res) => {
    try {
      const result = await service.createJob(req.body);
      res.status(202).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_job_request", detail: String(error) });
    }
  });

  app.get("/v1/jobs/:jobId", async (req, res) => {
    const job = await service.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }

    res.status(200).json(job);
  });

  app.post("/v1/jobs/:jobId/cancel", async (req, res) => {
    try {
      const params = CancelParamsSchema.parse(req.params);
      const job = await service.cancelJob(params.jobId);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      res.status(200).json({ jobId: job.id, status: job.status });
    } catch (error) {
      res.status(400).json({ error: "invalid_cancel_request", detail: String(error) });
    }
  });

  app.post("/v1/jobs/:jobId/retry", async (req, res) => {
    try {
      const params = CancelParamsSchema.parse(req.params);
      const job = await service.retryJob(params.jobId);
      if (!job) {
        res.status(409).json({ error: "job_retry_unavailable" });
        return;
      }
      res.status(202).json({ jobId: job.id, status: job.status, retryOf: params.jobId });
    } catch (error) {
      res.status(400).json({ error: "invalid_retry_request", detail: String(error) });
    }
  });

  app.get("/v1/memory/status", (_req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    res.status(200).json(memoryService.memoryStatus());
  });

  app.post("/v1/memory/sync", async (_req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    await memoryService.syncMemory("manual_api");
    res.status(200).json({ synced: true, status: memoryService.memoryStatus() });
  });

  app.get("/v1/memory/search", async (req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    const query = typeof req.query.q === "string" ? req.query.q : "";
    const maxResults = typeof req.query.maxResults === "string" ? Number(req.query.maxResults) : undefined;
    const minScore = typeof req.query.minScore === "string" ? Number(req.query.minScore) : undefined;

    const results = await memoryService.searchMemory(query, { maxResults, minScore });
    res.status(200).json({ results });
  });

  app.get("/v1/memory/snippet", async (req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const from = typeof req.query.from === "string" ? Number(req.query.from) : undefined;
    const lines = typeof req.query.lines === "string" ? Number(req.query.lines) : undefined;

    try {
      const snippet = await memoryService.getMemorySnippet(filePath, from, lines);
      res.status(200).json({ snippet });
    } catch (error) {
      res.status(400).json({ error: "invalid_snippet_request", detail: String(error) });
    }
  });

  app.post("/v1/memory/notes", async (req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    if (!req.body || typeof req.body.text !== "string" || req.body.text.trim().length === 0) {
      res.status(400).json({ error: "invalid_note_payload" });
      return;
    }

    const date = typeof req.body.date === "string" ? req.body.date : undefined;
    const written = await memoryService.appendMemoryNote(req.body.text, date);
    res.status(201).json(written);
  });

  app.post("/v1/auth/openai/start", async (req, res) => {
    if (!oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    try {
      const input = SessionBodySchema.parse(req.body ?? {});
      const started = await oauthService.startOpenAiConnect(input.sessionId);
      res.status(200).json(started);
    } catch (error) {
      res.status(400).json({ error: "invalid_oauth_start_request", detail: String(error) });
    }
  });

  app.get("/v1/auth/openai/status", async (req, res) => {
    if (!oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const status = await oauthService.statusOpenAi(sessionId);
    res.status(200).json(status);
  });

  app.post("/v1/auth/openai/disconnect", async (req, res) => {
    if (!oauthService) {
      res.status(404).json({ error: "oauth_not_configured" });
      return;
    }

    try {
      const input = SessionBodySchema.parse(req.body ?? {});
      const removed = await oauthService.disconnectOpenAi(input.sessionId);
      res.status(200).json({ disconnected: removed, sessionId: input.sessionId, provider: "openai" });
    } catch (error) {
      res.status(400).json({ error: "invalid_oauth_disconnect_request", detail: String(error) });
    }
  });

  app.get("/v1/auth/openai/callback", async (req, res) => {
    if (!oauthService) {
      res.status(404).type("html").send("<h1>OAuth not configured</h1>");
      return;
    }

    try {
      const query = CallbackQuerySchema.parse(req.query ?? {});
      const completed = await oauthService.completeOpenAiCallback(query);
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

  app.get("/v1/auth/openai/mock/authorize", async (req, res) => {
    if (!oauthService || oauthService.getOpenAiMode() !== "mock") {
      res.status(404).type("html").send("<h1>Mock OAuth mode is disabled</h1>");
      return;
    }

    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) {
      res.status(400).type("html").send("<h1>Missing state</h1>");
      return;
    }

    const exists = await oauthService.hasPendingOpenAiState(state);
    if (!exists) {
      res.status(400).type("html").send("<h1>Invalid or expired OAuth state</h1>");
      return;
    }

    res.status(200).type("html").send(oauthService.renderMockAuthorizePage(state));
  });

  return app;
}
