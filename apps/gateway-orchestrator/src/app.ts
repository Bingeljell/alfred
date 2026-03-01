import express from "express";
import { FileBackedQueueStore } from "./local_queue_store";
import { GatewayService } from "./gateway_service";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { renderWebConsoleHtml } from "./ui/render_web_console";
import { renderUiHomeHtml } from "./ui/render_ui_home";
import { renderUiTranscriptsHtml } from "./ui/render_ui_transcripts";
import type { CreateGatewayAppOptions } from "./app_types";
import { registerAuthRoutes } from "./routes/auth_routes";
import { registerChannelRoutes } from "./routes/channel_routes";
import { registerCoreRoutes } from "./routes/core_routes";
import { registerHeartbeatRoutes } from "./routes/heartbeat_routes";
import { registerMemoryRoutes } from "./routes/memory_routes";
import { registerObservabilityRoutes } from "./routes/observability_routes";

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
  options?: CreateGatewayAppOptions
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

  registerCoreRoutes(app, {
    health: () => service.health(),
    renderUiHome: () => renderUiHomeHtml(),
    renderUiTranscripts: () => renderUiTranscriptsHtml(),
    renderUiConsole: () => renderWebConsoleHtml()
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
    },
    executionPolicyService: {
      previewExecutionPolicy: (input) => service.previewExecutionPolicy(input)
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
