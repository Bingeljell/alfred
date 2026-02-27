import express from "express";
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
import { registerAuthRoutes } from "./routes/auth_routes";
import { registerChannelRoutes } from "./routes/channel_routes";
import { registerHeartbeatRoutes } from "./routes/heartbeat_routes";
import { registerMemoryRoutes } from "./routes/memory_routes";
import { registerObservabilityRoutes } from "./routes/observability_routes";
import type { MemoryCheckpointClass } from "./builtins/memory_checkpoint_service";
import type { LlmAuthPreference, PlannerDecision } from "./orchestrator/types";

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

  registerHeartbeatRoutes(app, { heartbeatService });

  registerObservabilityRoutes(app, {
    conversationStore,
    runLedger,
    runSpecStore: runSpecStore
      ? {
          get: (runId: string) => runSpecStore.get(runId)
        }
      : undefined,
    supervisorStore,
    approvalService: {
      listPendingApprovals: (sessionId: string, limit?: number) => service.listPendingApprovals(sessionId, limit),
      handleInbound: (input) => service.handleInbound(input)
    }
  });

  registerChannelRoutes(app, {
    service,
    dedupeStore,
    identityProfileStore,
    whatsAppLiveManager,
    baileysInboundToken,
    withQrImageData,
    isAuthorizedBaileysInbound
  });

  registerMemoryRoutes(app, {
    memoryService,
    memoryCompactionService,
    memoryCheckpointService
  });

  registerAuthRoutes(app, {
    oauthService,
    codexAuthService,
    codexLoginMode: options?.codexLoginMode,
    codexApiKey: options?.codexApiKey
  });

  return app;
}
