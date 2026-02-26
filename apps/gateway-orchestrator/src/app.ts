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
import { renderUiHomeHtml } from "./ui/render_ui_home";
import { renderUiTranscriptsHtml } from "./ui/render_ui_transcripts";
import { OAuthService } from "./auth/oauth_service";
import { CodexAuthService, type CodexLoginStartMode } from "./codex/auth_service";
import { ConversationStore } from "./builtins/conversation_store";
import { IdentityProfileStore } from "./auth/identity_profile_store";
import { RunLedgerStore } from "./builtins/run_ledger_store";
import { SupervisorStore } from "./builtins/supervisor_store";
import { RunSpecStore } from "./builtins/run_spec_store";
import type { MemoryCheckpointClass } from "./builtins/memory_checkpoint_service";
import type { LlmAuthPreference, PlannerDecision } from "./orchestrator/types";

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

const IdentityMappingBodySchema = z.object({
  whatsAppJid: z.string().min(1),
  authSessionId: z.string().min(1)
});

const HeartbeatConfigureBodySchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(15000).max(24 * 60 * 60 * 1000).optional(),
  activeHoursStart: z.number().int().min(0).max(23).optional(),
  activeHoursEnd: z.number().int().min(0).max(23).optional(),
  requireIdleQueue: z.boolean().optional(),
  dedupeWindowMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
  suppressOk: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  pendingNotificationAlertThreshold: z.number().int().min(1).max(1000).optional(),
  recentErrorLookbackMinutes: z.number().int().min(1).max(24 * 60).optional(),
  alertOnAuthDisconnected: z.boolean().optional(),
  alertOnWhatsAppDisconnected: z.boolean().optional(),
  alertOnStuckJobs: z.boolean().optional(),
  stuckJobThresholdMinutes: z.number().int().min(1).max(24 * 60).optional()
});

const HeartbeatRunBodySchema = z.object({
  force: z.boolean().optional()
});

const MemoryCompactionRunBodySchema = z.object({
  force: z.boolean().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const ApprovalResolveBodySchema = z.object({
  sessionId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  token: z.string().min(1).optional(),
  authSessionId: z.string().min(1).optional(),
  authPreference: z.enum(["auto", "oauth", "api_key"]).optional()
});

const DEFAULT_STREAM_KINDS = ["chat", "command", "job", "error"] as const;
const ConversationSourceValues = ["gateway", "whatsapp", "auth", "memory", "worker", "system"] as const;
const ConversationChannelValues = ["direct", "baileys", "api", "internal"] as const;
const ConversationKindValues = ["chat", "command", "job", "status", "error", "dedupe"] as const;
const ConversationDirectionValues = ["inbound", "outbound", "system"] as const;

function parseCsvFilter<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const allowedSet = new Set<string>(allowed);
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && allowedSet.has(item)) as T[];
  return values.length > 0 ? values : undefined;
}

const QRCode = require("qrcode") as {
  toDataURL: (
    text: string,
    options?: {
      errorCorrectionLevel?: "L" | "M" | "Q" | "H";
      margin?: number;
      width?: number;
      color?: { dark?: string; light?: string };
    }
  ) => Promise<string>;
};

export async function withQrImageData(status: unknown): Promise<unknown> {
  if (!status || typeof status !== "object") {
    return status;
  }

  const statusRecord = status as Record<string, unknown>;
  const qr = typeof statusRecord.qr === "string" ? statusRecord.qr : "";
  if (!qr) {
    return {
      ...statusRecord,
      qrImageDataUrl: null
    };
  }

  try {
    const qrImageDataUrl = await QRCode.toDataURL(qr, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#111827", light: "#ffffff" }
    });
    return {
      ...statusRecord,
      qrImageDataUrl
    };
  } catch {
    return {
      ...statusRecord,
      qrImageDataUrl: null
    };
  }
}

export function isAuthorizedBaileysInbound(expectedToken: string | undefined, providedHeader: unknown): boolean {
  if (!expectedToken) {
    return true;
  }

  const provided = typeof providedHeader === "string" ? providedHeader.trim() : "";
  return provided === expectedToken;
}

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
    llmService?: {
      generateText: (
        sessionId: string,
        input: string,
        options?: { authPreference?: LlmAuthPreference }
      ) => Promise<{ text: string } | null>;
    };
    webSearchService?: {
      search: (
        query: string,
        options: {
          provider?: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
          authSessionId: string;
          authPreference?: LlmAuthPreference;
        }
      ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
    };
    intentPlanner?: {
      plan: (
        sessionId: string,
        message: string,
        options?: { authPreference?: LlmAuthPreference; hasActiveJob?: boolean }
      ) => Promise<PlannerDecision>;
    };
    codexAuthService?: CodexAuthService;
    codexLoginMode?: CodexLoginStartMode;
    codexApiKey?: string;
    conversationStore?: ConversationStore;
    identityProfileStore?: IdentityProfileStore;
    runLedger?: RunLedgerStore;
    supervisorStore?: SupervisorStore;
    runSpecStore?: Pick<RunSpecStore, "get" | "put" | "grantStepApproval" | "appendEvent" | "setStatus" | "updateStep">;
    whatsAppLiveManager?: {
      status: () => unknown | Promise<unknown>;
      connect: () => Promise<unknown>;
      disconnect: () => Promise<unknown>;
    };
    heartbeatService?: {
      status: () => Promise<unknown> | unknown;
      configure: (patch: {
        enabled?: boolean;
        intervalMs?: number;
        activeHoursStart?: number;
        activeHoursEnd?: number;
        requireIdleQueue?: boolean;
        dedupeWindowMs?: number;
        suppressOk?: boolean;
        sessionId?: string;
        pendingNotificationAlertThreshold?: number;
        recentErrorLookbackMinutes?: number;
        alertOnAuthDisconnected?: boolean;
        alertOnWhatsAppDisconnected?: boolean;
        alertOnStuckJobs?: boolean;
        stuckJobThresholdMinutes?: number;
      }) => Promise<unknown>;
      runNow: (options?: { force?: boolean; trigger?: string }) => Promise<unknown>;
    };
    memoryCompactionService?: {
      status: () => Promise<unknown> | unknown;
      configure: (patch: {
        enabled?: boolean;
        intervalMs?: number;
        maxDaysPerRun?: number;
        minEventsPerDay?: number;
        maxEventsPerDay?: number;
        maxNoteChars?: number;
        sessionId?: string;
      }) => Promise<unknown>;
      runNow: (options?: { force?: boolean; trigger?: string; targetDate?: string }) => Promise<unknown>;
    };
    memoryCheckpointService?: {
      status: () => Promise<unknown> | unknown;
      checkpoint: (input: {
        sessionId: string;
        class: MemoryCheckpointClass;
        source: string;
        summary: string;
        details?: string;
        dedupeKey?: string;
        day?: string;
      }) => Promise<unknown>;
    };
    pagedResponseStore?: {
      popNext: (sessionId: string) => Promise<{ page: string; remaining: number } | null>;
      clear: (sessionId: string) => Promise<void>;
    };
    capabilityPolicy?: {
      workspaceDir?: string;
      approvalMode?: "strict" | "balanced" | "relaxed";
      approvalDefault?: boolean;
      webSearchEnabled?: boolean;
      webSearchRequireApproval?: boolean;
      webSearchProvider?: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
      fileWriteEnabled?: boolean;
      fileWriteRequireApproval?: boolean;
      fileWriteNotesOnly?: boolean;
      fileWriteNotesDir?: string;
    };
    baileysInboundToken?: string;
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
    options?.llmService,
    options?.codexAuthService,
    options?.codexLoginMode,
    options?.codexApiKey,
    options?.conversationStore,
    options?.identityProfileStore,
    options?.memoryService,
    options?.capabilityPolicy,
    options?.webSearchService,
    options?.pagedResponseStore,
    options?.intentPlanner,
    options?.runLedger,
    options?.supervisorStore,
    options?.memoryCheckpointService,
    options?.runSpecStore
  );
  const dedupeStore = options?.dedupeStore ?? new MessageDedupeStore(process.cwd());
  const memoryService = options?.memoryService;
  const oauthService = options?.oauthService;
  const codexAuthService = options?.codexAuthService;
  const whatsAppLiveManager = options?.whatsAppLiveManager;
  const heartbeatService = options?.heartbeatService;
  const memoryCompactionService = options?.memoryCompactionService;
  const memoryCheckpointService = options?.memoryCheckpointService;
  const conversationStore = options?.conversationStore;
  const identityProfileStore = options?.identityProfileStore;
  const runLedger = options?.runLedger;
  const supervisorStore = options?.supervisorStore;
  const runSpecStore = options?.runSpecStore;
  const baileysInboundToken = options?.baileysInboundToken?.trim() ? options.baileysInboundToken.trim() : undefined;
  void dedupeStore.ensureReady();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.redirect(302, "/ui");
  });

  app.get("/ui", (_req, res) => {
    res.status(200).type("html").send(renderUiHomeHtml());
  });

  app.get("/ui/transcripts", (_req, res) => {
    res.status(200).type("html").send(renderUiTranscriptsHtml());
  });

  app.get("/ui/console", (_req, res) => {
    res.status(200).type("html").send(renderWebConsoleHtml());
  });

  app.get("/health", async (_req, res) => {
    const health = await service.health();
    res.status(200).json(health);
  });

  app.get("/v1/heartbeat/status", async (_req, res) => {
    if (!heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    const status = await heartbeatService.status();
    res.status(200).json(status);
  });

  app.post("/v1/heartbeat/configure", async (req, res) => {
    if (!heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    try {
      const patch = HeartbeatConfigureBodySchema.parse(req.body ?? {});
      const status = await heartbeatService.configure(patch);
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_heartbeat_config", detail: String(error) });
    }
  });

  app.post("/v1/heartbeat/run", async (req, res) => {
    if (!heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    try {
      const input = HeartbeatRunBodySchema.parse(req.body ?? {});
      const status = await heartbeatService.runNow({ force: input.force ?? true, trigger: "manual_api" });
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_heartbeat_run_request", detail: String(error) });
    }
  });

  app.get("/v1/stream/events", async (req, res) => {
    if (!conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }

    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const noisy =
      typeof req.query.noisy === "string" &&
      (req.query.noisy.toLowerCase() === "true" || req.query.noisy === "1");
    const kinds = parseCsvFilter(req.query.kinds, ConversationKindValues) ?? (noisy ? undefined : [...DEFAULT_STREAM_KINDS]);
    const sources = parseCsvFilter(req.query.sources, ConversationSourceValues);
    const channels = parseCsvFilter(req.query.channels, ConversationChannelValues);
    const directions = parseCsvFilter(req.query.directions, ConversationDirectionValues);
    const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
    const since = typeof req.query.since === "string" ? req.query.since.trim() : "";
    const until = typeof req.query.until === "string" ? req.query.until.trim() : "";

    const events = await conversationStore.query({
      sessionId: sessionId || undefined,
      limit,
      kinds,
      sources,
      channels,
      directions,
      text: text || undefined,
      since: since || undefined,
      until: until || undefined
    });
    res.status(200).json({ events });
  });

  app.get("/v1/runs", async (req, res) => {
    if (!runLedger) {
      res.status(404).json({ error: "run_ledger_not_configured" });
      return;
    }

    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey.trim() : "";
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 50;
    const runs = await runLedger.listRuns({
      sessionKey: sessionKey || undefined,
      limit
    });
    res.status(200).json({ runs });
  });

  app.get("/v1/runs/:runId", async (req, res) => {
    if (!runLedger) {
      res.status(404).json({ error: "run_ledger_not_configured" });
      return;
    }

    const run = await runLedger.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    const runSpec = runSpecStore ? await runSpecStore.get(req.params.runId) : null;
    res.status(200).json({
      ...run,
      runSpec
    });
  });

  app.get("/v1/supervisors", async (req, res) => {
    if (!supervisorStore) {
      res.status(404).json({ error: "supervisor_not_configured" });
      return;
    }

    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
    const runs = await supervisorStore.list({
      sessionId: sessionId || undefined,
      limit
    });
    res.status(200).json({ runs });
  });

  app.get("/v1/supervisors/:id", async (req, res) => {
    if (!supervisorStore) {
      res.status(404).json({ error: "supervisor_not_configured" });
      return;
    }
    const run = await supervisorStore.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: "supervisor_not_found" });
      return;
    }
    res.status(200).json(run);
  });

  app.get("/v1/approvals/pending", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }

    const rawLimit = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 10;
    const pending = await service.listPendingApprovals(sessionId, limit);
    res.status(200).json({
      sessionId,
      count: pending.length,
      pending
    });
  });

  app.post("/v1/approvals/resolve", async (req, res) => {
    const parsed = ApprovalResolveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_approval_resolve_request", detail: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const text =
      payload.decision === "approve"
        ? payload.token
          ? `approve ${payload.token}`
          : "yes"
        : payload.token
          ? `reject ${payload.token}`
          : "no";

    const result = await service.handleInbound({
      sessionId: payload.sessionId,
      text,
      requestJob: false,
      metadata: {
        ...(payload.authSessionId ? { authSessionId: payload.authSessionId } : {}),
        ...(payload.authPreference ? { authPreference: payload.authPreference } : {})
      }
    });
    res.status(200).json(result);
  });

  app.get("/v1/stream/events/subscribe", async (req, res) => {
    if (!conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }

    const limitRaw = Number(req.query.limit ?? 40);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 40;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const noisy =
      typeof req.query.noisy === "string" &&
      (req.query.noisy.toLowerCase() === "true" || req.query.noisy === "1");
    const kinds = parseCsvFilter(req.query.kinds, ConversationKindValues) ?? (noisy ? undefined : [...DEFAULT_STREAM_KINDS]);
    const sources = parseCsvFilter(req.query.sources, ConversationSourceValues);
    const channels = parseCsvFilter(req.query.channels, ConversationChannelValues);
    const directions = parseCsvFilter(req.query.directions, ConversationDirectionValues);
    const text = typeof req.query.text === "string" ? req.query.text.trim().toLowerCase() : "";
    const since = typeof req.query.since === "string" ? req.query.since.trim() : "";
    const until = typeof req.query.until === "string" ? req.query.until.trim() : "";
    const sourceSet = sources ? new Set(sources) : null;
    const channelSet = channels ? new Set(channels) : null;
    const kindSet = kinds ? new Set(kinds) : null;
    const directionSet = directions ? new Set(directions) : null;
    const sinceUnixMs = since ? Date.parse(since) : Number.NaN;
    const sinceEnabled = Number.isFinite(sinceUnixMs);
    const untilUnixMs = until ? Date.parse(until) : Number.NaN;
    const untilEnabled = Number.isFinite(untilUnixMs);

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");

    const initialEvents = await conversationStore.query({
      sessionId: sessionId || undefined,
      limit,
      kinds,
      sources,
      channels,
      directions,
      text: text || undefined,
      since: since || undefined,
      until: until || undefined
    });
    for (const event of initialEvents) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = conversationStore.subscribe((event) => {
      if (sessionId && event.sessionId !== sessionId) {
        return;
      }
      if (sourceSet && !sourceSet.has(event.source)) {
        return;
      }
      if (channelSet && !channelSet.has(event.channel)) {
        return;
      }
      if (kindSet && !kindSet.has(event.kind)) {
        return;
      }
      if (directionSet && !directionSet.has(event.direction)) {
        return;
      }
      if (text && !event.text.toLowerCase().includes(text)) {
        return;
      }
      if (sinceEnabled) {
        const eventUnixMs = Date.parse(event.createdAt);
        if (Number.isFinite(eventUnixMs) && eventUnixMs < sinceUnixMs) {
          return;
        }
      }
      if (untilEnabled) {
        const eventUnixMs = Date.parse(event.createdAt);
        if (Number.isFinite(eventUnixMs) && eventUnixMs >= untilUnixMs) {
          return;
        }
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const keepalive = setInterval(() => {
      res.write(":keepalive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    });
  });

  app.get("/v1/identity/mappings", async (_req, res) => {
    if (!identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }

    const mappings = await identityProfileStore.listMappings(500);
    res.status(200).json({ mappings });
  });

  app.get("/v1/identity/resolve", async (req, res) => {
    if (!identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }
    const whatsAppJid = typeof req.query.whatsAppJid === "string" ? req.query.whatsAppJid.trim() : "";
    if (!whatsAppJid) {
      res.status(400).json({ error: "missing_whatsapp_jid" });
      return;
    }

    const mapping = await identityProfileStore.getMapping(whatsAppJid);
    if (!mapping) {
      res.status(404).json({ error: "identity_mapping_not_found", whatsAppJid });
      return;
    }
    res.status(200).json(mapping);
  });

  app.post("/v1/identity/mappings", async (req, res) => {
    if (!identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }

    try {
      const input = IdentityMappingBodySchema.parse(req.body ?? {});
      const saved = await identityProfileStore.setMapping(input.whatsAppJid, input.authSessionId);
      res.status(200).json(saved);
    } catch (error) {
      res.status(400).json({ error: "invalid_identity_mapping", detail: String(error) });
    }
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
    if (!isAuthorizedBaileysInbound(baileysInboundToken, req.headers["x-baileys-inbound-token"])) {
      res.status(401).json({ error: "unauthorized_baileys_inbound" });
      return;
    }

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

  app.get("/v1/whatsapp/live/status", async (_req, res) => {
    if (!whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    const status = await whatsAppLiveManager.status();
    const withQrImage = await withQrImageData(status);
    res.status(200).json(withQrImage);
  });

  app.post("/v1/whatsapp/live/connect", async (_req, res) => {
    if (!whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    try {
      const status = await whatsAppLiveManager.connect();
      const withQrImage = await withQrImageData(status);
      res.status(200).json(withQrImage);
    } catch (error) {
      res.status(400).json({ error: "whatsapp_live_connect_failed", detail: String(error) });
    }
  });

  app.post("/v1/whatsapp/live/disconnect", async (_req, res) => {
    if (!whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    try {
      const status = await whatsAppLiveManager.disconnect();
      const withQrImage = await withQrImageData(status);
      res.status(200).json(withQrImage);
    } catch (error) {
      res.status(400).json({ error: "whatsapp_live_disconnect_failed", detail: String(error) });
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

  app.get("/v1/memory/compaction/status", async (_req, res) => {
    if (!memoryCompactionService) {
      res.status(404).json({ error: "memory_compaction_not_configured" });
      return;
    }

    const status = await memoryCompactionService.status();
    res.status(200).json(status);
  });

  app.post("/v1/memory/compaction/run", async (req, res) => {
    if (!memoryCompactionService) {
      res.status(404).json({ error: "memory_compaction_not_configured" });
      return;
    }

    try {
      const input = MemoryCompactionRunBodySchema.parse(req.body ?? {});
      const status = await memoryCompactionService.runNow({
        force: input.force ?? true,
        targetDate: input.targetDate,
        trigger: "manual_api"
      });
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_memory_compaction_run_request", detail: String(error) });
    }
  });

  app.get("/v1/memory/checkpoints/status", async (_req, res) => {
    if (!memoryCheckpointService) {
      res.status(404).json({ error: "memory_checkpoints_not_configured" });
      return;
    }

    const status = await memoryCheckpointService.status();
    res.status(200).json(status);
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
    if (codexAuthService) {
      try {
        const input = SessionBodySchema.parse(req.body ?? {});
        const started = await codexAuthService.startLogin(options?.codexLoginMode ?? "chatgpt", options?.codexApiKey);
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
    if (codexAuthService) {
      try {
        const status = await codexAuthService.readStatus(false);
        const telemetry = await codexAuthService.telemetry();
        const lastLogin = telemetry?.lastLogin ?? codexAuthService.lastLoginResult();
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
    if (codexAuthService) {
      try {
        const input = SessionBodySchema.parse(req.body ?? {});
        await codexAuthService.logout();
        res.status(200).json({ disconnected: true, sessionId: input.sessionId, provider: "openai-codex" });
      } catch (error) {
        res.status(400).json({ error: "codex_auth_disconnect_failed", detail: String(error) });
      }
      return;
    }

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

  app.get("/v1/auth/openai/rate-limits", async (_req, res) => {
    if (!codexAuthService) {
      res.status(404).json({ error: "codex_auth_not_configured" });
      return;
    }

    try {
      const limits = await codexAuthService.readRateLimits();
      res.status(200).json(limits);
    } catch (error) {
      res.status(400).json({ error: "codex_rate_limits_failed", detail: String(error) });
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
