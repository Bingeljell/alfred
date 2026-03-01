import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { JobCreateSchema, RunSpecV1Schema } from "../../../packages/contracts/src";
import type { RunSpecV1 } from "../../../packages/contracts/src";
import { parseCommand, type ParsedCommand } from "./builtins/command_parser";
import { ApprovalStore } from "./builtins/approval_store";
import { NoteStore } from "./builtins/note_store";
import { ReminderStore } from "./builtins/reminder_store";
import { TaskStore } from "./builtins/task_store";
import { FileBackedQueueStore } from "./local_queue_store";
import { OutboundNotificationStore } from "./notification_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { normalizeBaileysInbound } from "./whatsapp/normalize_baileys";
import { OAuthService } from "./auth/oauth_service";
import { CodexAuthService, type CodexLoginStartMode } from "./codex/auth_service";
import { ConversationStore } from "./builtins/conversation_store";
import { IdentityProfileStore } from "./auth/identity_profile_store";
import type { MemoryResult, MemoryService } from "../../../packages/memory/src";
import type { WebSearchProvider } from "./builtins/web_search_service";
import type { RunQueueMode } from "./builtins/run_ledger_store";
import type { SupervisorStore } from "./builtins/supervisor_store";
import type { MemoryCheckpointClass } from "./builtins/memory_checkpoint_service";
import type { RunSpecStore } from "./builtins/run_spec_store";
import { runNormalizePhase } from "./orchestrator/normalize_phase";
import { runSessionPhase } from "./orchestrator/session_phase";
import type { LlmAuthPreference, LlmExecutionMode, PlannerDecision } from "./orchestrator/types";
import {
  runDirectivesPhase,
  runDispatchPhase,
  runPersistPhase,
  runPlanPhase,
  runPolicyPhase,
  runRoutePhase
} from "./orchestrator/turn_phase_handlers";
import {
  TOOL_SPECS_V1,
  evaluateToolPolicy,
  type ExternalCapability,
  type ToolId,
  type ToolPolicyInput
} from "./orchestrator/tool_policy_engine";
import {
  evaluateShellCommandPolicy as evaluateSandboxShellCommandPolicy,
  isSandboxTargetEnabled
} from "./orchestrator/sandbox_policy";

type ImplicitApprovalDecision = "approve_latest" | "reject_latest";
type RoutedLongTask = {
  taskType: "agentic_turn" | "web_search" | "web_to_file";
  query: string;
  provider?: WebSearchProvider;
  fileFormat?: "md" | "txt" | "doc";
  reason: string;
};

type MemoryReference = {
  source: string;
  class: MemoryCheckpointClass;
};

type InboundHandleResult = {
  accepted: boolean;
  mode: "chat" | "async-job";
  response?: string;
  jobId?: string;
};

type CapabilityPolicy = {
  workspaceDir: string;
  approvalMode: "strict" | "balanced" | "relaxed";
  approvalDefault: boolean;
  webSearchEnabled: boolean;
  webSearchRequireApproval: boolean;
  webSearchProvider: WebSearchProvider;
  fileWriteEnabled: boolean;
  fileWriteRequireApproval: boolean;
  fileWriteNotesOnly: boolean;
  fileWriteNotesDir: string;
  fileWriteApprovalMode: "per_action" | "session" | "always";
  fileWriteApprovalScope: "auth" | "channel";
  shellEnabled: boolean;
  shellAllowedDirs: string[];
  shellTimeoutMs: number;
  shellMaxOutputChars: number;
  wasmEnabled: boolean;
};

const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = {
  workspaceDir: path.resolve(process.cwd(), "workspace", "alfred"),
  approvalMode: "balanced",
  approvalDefault: true,
  webSearchEnabled: true,
  webSearchRequireApproval: false,
  webSearchProvider: "searxng",
  fileWriteEnabled: false,
  fileWriteRequireApproval: true,
  fileWriteNotesOnly: true,
  fileWriteNotesDir: "notes",
  fileWriteApprovalMode: "session",
  fileWriteApprovalScope: "auth",
  shellEnabled: false,
  shellAllowedDirs: [path.resolve(process.cwd(), "workspace", "alfred")],
  shellTimeoutMs: 20_000,
  shellMaxOutputChars: 8_000,
  wasmEnabled: false
};

type LocalOpsProposal = {
  needsClarification: boolean;
  question?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  confidence: number;
};

type LocalOpsRouteResult = {
  response: string;
  plannerAction: string;
  note: string;
  details?: Record<string, unknown>;
};

export class GatewayService {
  private readonly capabilityPolicy: CapabilityPolicy;
  private readonly fileWriteApprovalLeases = new Set<string>();
  private readonly webSearchService?: {
    search: (
      query: string,
      options: {
        provider?: WebSearchProvider;
        authSessionId: string;
        authPreference?: LlmAuthPreference;
      }
    ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
  };

  constructor(
    private readonly store: FileBackedQueueStore,
    private readonly notificationStore?: OutboundNotificationStore,
    private readonly reminderStore?: ReminderStore,
    private readonly noteStore?: NoteStore,
    private readonly taskStore?: TaskStore,
    private readonly approvalStore?: ApprovalStore,
    private readonly oauthService?: OAuthService,
    private readonly llmService?: {
      generateText: (
        sessionId: string,
        input: string,
        options?: { authPreference?: LlmAuthPreference; executionMode?: LlmExecutionMode }
      ) => Promise<{ text: string } | null>;
    },
    private readonly codexAuthService?: CodexAuthService,
    private readonly codexLoginMode: CodexLoginStartMode = "chatgpt",
    private readonly codexApiKey?: string,
    private readonly conversationStore?: ConversationStore,
    private readonly identityProfileStore?: IdentityProfileStore,
    private readonly memoryService?: Pick<MemoryService, "searchMemory">,
    capabilityPolicy?: Partial<CapabilityPolicy>,
    webSearchService?: {
      search: (
        query: string,
        options: {
          provider?: WebSearchProvider;
          authSessionId: string;
          authPreference?: LlmAuthPreference;
        }
      ) => Promise<{ provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata"; text: string } | null>;
    },
    private readonly pagedResponseStore?: {
      popNext: (sessionId: string) => Promise<{ page: string; remaining: number } | null>;
      clear: (sessionId: string) => Promise<void>;
    },
    private readonly intentPlanner?: {
      plan: (
        sessionId: string,
        message: string,
        options?: { authPreference?: LlmAuthPreference; hasActiveJob?: boolean }
      ) => Promise<PlannerDecision>;
    },
    private readonly runLedger?: {
      startRun: (input: {
        sessionKey: string;
        queueMode?: RunQueueMode;
        idempotencyKey?: string;
        model?: string;
        provider?: string;
        toolPolicySnapshot?: Record<string, unknown>;
        skillsSnapshot?: { hash?: string; content?: string[] };
      }) => Promise<{
        acquired: boolean;
        run: { runId: string };
        activeRunId?: string;
      }>;
      transitionPhase: (
        runId: string,
        phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
        message?: string,
        payload?: Record<string, unknown>
      ) => Promise<unknown>;
      appendEvent: (
        runId: string,
        type: "note" | "queued" | "progress" | "tool_event" | "partial",
        phase?: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
        message?: string,
        payload?: Record<string, unknown>
      ) => Promise<unknown>;
      completeRun: (runId: string, status: "completed" | "failed" | "cancelled", message?: string) => Promise<unknown>;
    },
    private readonly supervisorStore?: SupervisorStore,
    private readonly memoryCheckpointService?: {
      checkpoint: (input: {
        sessionId: string;
        class: MemoryCheckpointClass;
        source: string;
        summary: string;
        details?: string;
        dedupeKey?: string;
        day?: string;
      }) => Promise<unknown>;
    },
    private readonly runSpecStore?: Pick<
      RunSpecStore,
      "put" | "get" | "grantStepApproval" | "appendEvent" | "setStatus" | "updateStep"
    >
  ) {
    this.webSearchService = webSearchService;
    const configuredShellTimeoutMs = Number(capabilityPolicy?.shellTimeoutMs);
    const configuredShellMaxOutputChars = Number(capabilityPolicy?.shellMaxOutputChars);
    this.capabilityPolicy = {
      ...DEFAULT_CAPABILITY_POLICY,
      ...(capabilityPolicy ?? {}),
      workspaceDir: path.resolve(capabilityPolicy?.workspaceDir ?? DEFAULT_CAPABILITY_POLICY.workspaceDir),
      approvalMode: capabilityPolicy?.approvalMode ?? DEFAULT_CAPABILITY_POLICY.approvalMode,
      webSearchProvider: this.normalizeWebSearchProvider(capabilityPolicy?.webSearchProvider) ?? DEFAULT_CAPABILITY_POLICY.webSearchProvider,
      fileWriteNotesDir: (capabilityPolicy?.fileWriteNotesDir ?? DEFAULT_CAPABILITY_POLICY.fileWriteNotesDir).trim() || "notes",
      fileWriteApprovalMode:
        capabilityPolicy?.fileWriteApprovalMode ?? DEFAULT_CAPABILITY_POLICY.fileWriteApprovalMode,
      fileWriteApprovalScope:
        capabilityPolicy?.fileWriteApprovalScope ?? DEFAULT_CAPABILITY_POLICY.fileWriteApprovalScope,
      shellEnabled:
        typeof capabilityPolicy?.shellEnabled === "boolean"
          ? capabilityPolicy.shellEnabled
          : DEFAULT_CAPABILITY_POLICY.shellEnabled,
      shellAllowedDirs: this.normalizeShellAllowedDirs(
        capabilityPolicy?.shellAllowedDirs,
        path.resolve(capabilityPolicy?.workspaceDir ?? DEFAULT_CAPABILITY_POLICY.workspaceDir)
      ),
      shellTimeoutMs: Number.isFinite(configuredShellTimeoutMs)
        ? Math.max(1000, Math.min(120000, Math.floor(configuredShellTimeoutMs)))
        : DEFAULT_CAPABILITY_POLICY.shellTimeoutMs,
      shellMaxOutputChars: Number.isFinite(configuredShellMaxOutputChars)
        ? Math.max(500, Math.min(50000, Math.floor(configuredShellMaxOutputChars)))
        : DEFAULT_CAPABILITY_POLICY.shellMaxOutputChars,
      wasmEnabled:
        typeof capabilityPolicy?.wasmEnabled === "boolean"
          ? capabilityPolicy.wasmEnabled
          : DEFAULT_CAPABILITY_POLICY.wasmEnabled
    };
  }

  async health(): Promise<{
    service: "gateway-orchestrator";
    status: "ok";
    queue: Record<string, number>;
    activeJobs: Array<{
      id: string;
      status: string;
      workerId?: string;
      taskType?: string;
      sessionId?: string;
      updatedAt: string;
      progress?: string;
      progressPhase?: string;
      progressDetails?: Record<string, unknown>;
    }>;
  }> {
    const queue = await this.store.statusCounts();
    const jobs = await this.store.listJobs();
    const activeJobs = jobs
      .filter((job) => job.status === "queued" || job.status === "running" || job.status === "cancelling")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 5)
      .map((job) => ({
        id: job.id,
        status: job.status,
        workerId: job.workerId,
        taskType: typeof job.payload.taskType === "string" ? job.payload.taskType : undefined,
        sessionId: typeof job.payload.sessionId === "string" ? job.payload.sessionId : undefined,
        updatedAt: job.updatedAt,
        progress: typeof job.progress?.message === "string" ? job.progress.message : undefined,
        progressPhase: typeof job.progress?.phase === "string" ? job.progress.phase : undefined,
        progressDetails:
          job.progress?.details && typeof job.progress.details === "object"
            ? (job.progress.details as Record<string, unknown>)
            : undefined
      }));
    return {
      service: "gateway-orchestrator",
      status: "ok",
      queue,
      activeJobs
    };
  }

  async handleInbound(payload: unknown): Promise<InboundHandleResult> {
    const normalized = runNormalizePhase(payload);
    const { inbound, provider, source, channel } = normalized;
    const session = await runSessionPhase({
      normalized,
      resolveAuthSessionId: (sessionId, currentProvider) => this.resolveAuthSessionId(sessionId, currentProvider),
      normalizeAuthPreference: (raw) => this.normalizeAuthPreference(raw),
      normalizeQueueMode: (raw) => this.normalizeQueueMode(raw),
      resolveIdempotencyKey: (raw) => this.resolveIdempotencyKey(raw),
      runLedger: this.runLedger,
      codexApiKey: this.codexApiKey,
      capabilityPolicySnapshot: {
        approvalMode: this.capabilityPolicy.approvalMode,
        approvalDefault: this.capabilityPolicy.approvalDefault,
        webSearchEnabled: this.capabilityPolicy.webSearchEnabled,
        webSearchRequireApproval: this.capabilityPolicy.webSearchRequireApproval,
        webSearchProvider: this.capabilityPolicy.webSearchProvider,
        fileWriteEnabled: this.capabilityPolicy.fileWriteEnabled,
        fileWriteRequireApproval: this.capabilityPolicy.fileWriteRequireApproval,
        fileWriteNotesOnly: this.capabilityPolicy.fileWriteNotesOnly,
        fileWriteNotesDir: this.capabilityPolicy.fileWriteNotesDir,
        fileWriteApprovalMode: this.capabilityPolicy.fileWriteApprovalMode,
        fileWriteApprovalScope: this.capabilityPolicy.fileWriteApprovalScope,
        shellEnabled: this.capabilityPolicy.shellEnabled,
        shellRequireApproval: this.requiresApproval("shell_exec"),
        shellAllowedDirs: this.capabilityPolicy.shellAllowedDirs,
        wasmEnabled: this.capabilityPolicy.wasmEnabled
      },
      buildSkillsSnapshot: () => this.buildSkillsSnapshot()
    });
    const { authSessionId, authPreference, queueMode, runStart, runId, markPhase, markRunNote } = session;

    await markPhase("normalize", "Inbound payload normalized", {
      source,
      channel,
      requestJob: inbound.requestJob,
      queueMode
    });
    await markPhase("session", "Resolved session routing", {
      sessionId: inbound.sessionId,
      authSessionId,
      authPreference
    });

    const busySessionResponse = await this.handleBusySession({
      runStart,
      queueMode,
      inbound,
      authSessionId,
      authPreference,
      runId,
      markPhase,
      markRunNote
    });
    if (busySessionResponse) {
      return busySessionResponse;
    }

    await this.recordConversation(inbound.sessionId, "inbound", inbound.text ?? "", {
      source,
      channel,
      kind: inbound.requestJob ? "job" : "chat",
      metadata: {
        ...(inbound.metadata && typeof inbound.metadata === "object" ? inbound.metadata : {}),
        authSessionId,
        authPreference,
        runId
      }
    });

    let runFailure: string | null = null;
    try {
      await runDirectivesPhase({ markPhase });

      if (inbound.requestJob) {
        return await this.handleExplicitJobRequest({
          inbound,
          runId,
          markPhase,
          markRunNote
        });
      }

      if (inbound.text) {
        const prePlannerResponse = await this.handlePrePlannerDirectiveSurface({
          inbound: {
            sessionId: inbound.sessionId,
            text: inbound.text
          },
          runId,
          authSessionId,
          authPreference,
          markPhase
        });
        if (prePlannerResponse) {
          return prePlannerResponse;
        }

        await runPlanPhase({ markPhase });
        const activeJob = await this.findLatestActiveJob(inbound.sessionId);
        const plan = await this.intentPlanner?.plan(authSessionId, inbound.text, {
          authPreference,
          hasActiveJob: activeJob !== null
        });
        let plannerTraceLogged = false;
        const recordPlannerTrace = async (chosenAction: string, extra?: Record<string, unknown>): Promise<void> => {
          if (!plan || plannerTraceLogged) {
            return;
          }
          plannerTraceLogged = true;
          const delegation = this.describeWorkerDelegationDecision(plan);
          const confidence = Number.isFinite(plan.confidence) ? plan.confidence : 0;
          const message = `Planner selected ${plan.intent} (${Math.round(confidence * 100)}%) -> ${chosenAction}`;
          await this.recordConversation(inbound.sessionId, "system", message, {
            source: "gateway",
            channel: "internal",
            kind: "command",
            metadata: {
              authSessionId,
              runId,
              plannerTrace: true,
              plannerIntent: plan.intent,
              plannerConfidence: confidence,
              plannerReason: plan.reason,
              plannerNeedsWorker: plan.needsWorker,
              plannerProvider: plan.provider,
              plannerSendAttachment: plan.sendAttachment,
              plannerFileFormat: plan.fileFormat,
              plannerFileName: plan.fileName,
              plannerQuery: plan.query,
              plannerQuestion: plan.question,
              plannerWillDelegateWorker: delegation.willDelegateWorker,
              plannerForcedWorkerDelegation: delegation.forcedByPolicy,
              plannerDelegationReason: delegation.reason,
              plannerChosenAction: chosenAction,
              ...(extra ?? {})
            }
          });
        };

        await runPolicyPhase({ markPhase });
        const primaryPlannerRoute = await this.handlePlannerPrimaryRoutes({
          inbound: {
            sessionId: inbound.sessionId,
            text: inbound.text
          },
          plan,
          runId,
          authSessionId,
          authPreference,
          markPhase,
          markRunNote,
          recordPlannerTrace
        });
        if (primaryPlannerRoute) {
          return primaryPlannerRoute;
        }

        return await this.handlePlannerFallbackRoutes({
          inbound: {
            sessionId: inbound.sessionId,
            text: inbound.text
          },
          runId,
          authSessionId,
          authPreference,
          markPhase,
          markRunNote,
          recordPlannerTrace
        });
      }

      await runPersistPhase({ markPhase }, "No inbound chat text received");
      return {
        accepted: true,
        mode: "chat",
        response: "No chat text received."
      };
    } catch (error) {
      runFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await session.completeRun(runFailure);
    }
  }

  async createJob(payload: unknown): Promise<{ jobId: string; status: string }> {
    const input = JobCreateSchema.parse(payload ?? {});
    const job = await this.store.createJob(input);

    const sessionId = typeof input.payload.sessionId === "string" ? input.payload.sessionId : undefined;
    if (sessionId) {
      await this.queueJobNotification(sessionId, job.id, "queued", `Job ${job.id} is queued`);
    }

    return { jobId: job.id, status: job.status };
  }

  async previewExecutionPolicy(input: {
    sessionId: string;
    text: string;
    authSessionId?: string;
    authPreference?: LlmAuthPreference;
  }): Promise<{
    sessionId: string;
    authSessionId: string;
    authPreference: LlmAuthPreference;
    commandDetected: string | null;
    implicitApprovalDetected: ImplicitApprovalDecision | null;
    hasActiveJob: boolean;
    plannerDecision: PlannerDecision | null;
    delegation: {
      willDelegateWorker: boolean;
      forcedByPolicy: boolean;
      reason: string;
    };
    predictedRoute:
      | "command_surface"
      | "approval_surface"
      | "status_query"
      | "clarify"
      | "worker_run_spec"
      | "worker_agentic_turn"
      | "chat_turn";
  }> {
    const sessionId = input.sessionId.trim();
    const text = input.text.trim();
    const authPreference = this.normalizeAuthPreference(input.authPreference);
    const authSessionId = input.authSessionId?.trim() || sessionId;
    const command = parseCommand(text);
    const implicitApproval = this.parseImplicitApprovalDecision(text);
    const hasActiveJob = (await this.findLatestActiveJob(sessionId)) !== null;

    const plannerDecision = this.intentPlanner
      ? await this.intentPlanner.plan(authSessionId, text, { authPreference, hasActiveJob })
      : null;
    const delegation = plannerDecision
      ? this.describeWorkerDelegationDecision(plannerDecision)
      : { willDelegateWorker: false, forcedByPolicy: false, reason: "planner_not_configured" };

    let predictedRoute:
      | "command_surface"
      | "approval_surface"
      | "status_query"
      | "clarify"
      | "worker_run_spec"
      | "worker_agentic_turn"
      | "chat_turn" = "chat_turn";

    if (command) {
      predictedRoute = "command_surface";
    } else if (implicitApproval) {
      predictedRoute = "approval_surface";
    } else if (plannerDecision?.intent === "status_query") {
      predictedRoute = "status_query";
    } else if (plannerDecision?.intent === "clarify") {
      predictedRoute = "clarify";
    } else if (plannerDecision && delegation.willDelegateWorker) {
      predictedRoute = plannerDecision.sendAttachment ? "worker_run_spec" : "worker_agentic_turn";
    }

    return {
      sessionId,
      authSessionId,
      authPreference,
      commandDetected: command?.kind ?? null,
      implicitApprovalDetected: implicitApproval,
      hasActiveJob,
      plannerDecision,
      delegation,
      predictedRoute
    };
  }

  private async handleBusySession(input: {
    runStart?: { acquired: boolean; activeRunId?: string };
    queueMode: RunQueueMode;
    inbound: { sessionId: string; text?: string };
    authSessionId: string;
    authPreference: LlmAuthPreference;
    runId?: string;
    markPhase: (
      phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
      message?: string,
      details?: Record<string, unknown>
    ) => Promise<void>;
    markRunNote: (message: string, details?: Record<string, unknown>) => Promise<void>;
  }): Promise<InboundHandleResult | null> {
    const { runStart } = input;
    if (!runStart || runStart.acquired) {
      return null;
    }

    await runDispatchPhase({ markPhase: input.markPhase }, "Session is currently busy", {
      activeRunId: runStart.activeRunId
    });

    if (input.queueMode !== "steer" && input.inbound.text?.trim()) {
      const followupJob = await this.store.createJob({
        type: "chat_turn",
        payload: {
          taskType: "chat_turn",
          text: input.inbound.text.trim(),
          sessionId: input.inbound.sessionId,
          authSessionId: input.authSessionId,
          authPreference: input.authPreference,
          queuedFromRunId: runStart.activeRunId
        },
        priority: input.queueMode === "followup" ? 4 : 6
      });
      await input.markRunNote("Collected follow-up while session busy", {
        followupJobId: followupJob.id,
        queueMode: input.queueMode
      });
      if (input.runId && this.runLedger) {
        await this.runLedger.completeRun(input.runId, "completed", `queued_followup:${followupJob.id}`);
      }
      return {
        accepted: true,
        mode: "async-job",
        response: `Session is currently busy with run ${String(runStart.activeRunId ?? "unknown")}. Collected this as follow-up job ${followupJob.id}.`,
        jobId: followupJob.id
      };
    }

    if (input.runId && this.runLedger) {
      await this.runLedger.completeRun(input.runId, "cancelled", `session_busy:${String(runStart.activeRunId ?? "unknown")}`);
    }
    return {
      accepted: true,
      mode: "chat",
      response: `Session is busy with run ${String(runStart.activeRunId ?? "unknown")}. Please retry shortly.`
    };
  }

  private async handleExplicitJobRequest(input: {
    inbound: { sessionId: string; text?: string; metadata?: Record<string, unknown> };
    runId?: string;
    markPhase: (
      phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
      message?: string,
      details?: Record<string, unknown>
    ) => Promise<void>;
    markRunNote: (message: string, details?: Record<string, unknown>) => Promise<void>;
  }): Promise<InboundHandleResult> {
    await runRoutePhase({ markPhase: input.markPhase }, "Inbound requested async job");
    const job = await this.store.createJob({
      type: "stub_task",
      payload: {
        text: input.inbound.text,
        sessionId: input.inbound.sessionId,
        ...input.inbound.metadata
      },
      priority: 5
    });

    await this.queueJobNotification(input.inbound.sessionId, job.id, "queued", `Job ${job.id} is queued`);
    await input.markRunNote("Async job queued from inbound request", { jobId: job.id });
    await runPersistPhase({ markPhase: input.markPhase }, "Persisting async job acknowledgement", { jobId: job.id });
    await this.recordConversation(input.inbound.sessionId, "outbound", `Job ${job.id} queued`, {
      source: "gateway",
      channel: "internal",
      kind: "job",
      metadata: { jobId: job.id, status: "queued", runId: input.runId }
    });

    return {
      accepted: true,
      mode: "async-job",
      jobId: job.id
    };
  }

  private async handlePrePlannerDirectiveSurface(input: {
    inbound: { sessionId: string; text: string };
    runId?: string;
    authSessionId: string;
    authPreference: LlmAuthPreference;
    markPhase: (
      phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
      message?: string,
      details?: Record<string, unknown>
    ) => Promise<void>;
  }): Promise<InboundHandleResult | null> {
    const paging = await this.handlePagingRequest(input.inbound.sessionId, input.inbound.text);
    if (paging) {
      await runPersistPhase({ markPhase: input.markPhase }, "Serving paged response");
      await this.recordConversation(input.inbound.sessionId, "outbound", paging, {
        source: "gateway",
        channel: "internal",
        kind: "command",
        metadata: { authSessionId: input.authSessionId, runId: input.runId }
      });
      return {
        accepted: true,
        mode: "chat",
        response: paging
      };
    }

    const directiveCommand = parseCommand(input.inbound.text);
    if (directiveCommand) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing directive command execution", { command: directiveCommand.kind });
      const response = await this.executeCommand(input.inbound.sessionId, directiveCommand, input.authSessionId, input.authPreference);
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting directive command response", {
        command: directiveCommand.kind
      });
      await this.recordConversation(input.inbound.sessionId, "outbound", response, {
        source: "gateway",
        channel: "internal",
        kind: "command",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response
      };
    }

    const implicitApprovalDecision = this.parseImplicitApprovalDecision(input.inbound.text);
    if (implicitApprovalDecision) {
      const decisionResult = await this.executeImplicitApprovalDecision(
        input.inbound.sessionId,
        implicitApprovalDecision,
        input.authSessionId,
        input.authPreference
      );
      if (decisionResult.handled) {
        await runRoutePhase({ markPhase: input.markPhase }, "Routing implicit approval decision", {
          decision: implicitApprovalDecision
        });
        await runPersistPhase({ markPhase: input.markPhase }, "Persisting implicit approval response");
        await this.recordConversation(input.inbound.sessionId, "outbound", decisionResult.response, {
          source: "gateway",
          channel: "internal",
          kind: "command",
          metadata: {
            authSessionId: input.authSessionId,
            runId: input.runId
          }
        });
        return {
          accepted: true,
          mode: "chat",
          response: decisionResult.response
        };
      }
    }

    const directProgressStatus = await this.answerProgressQuery(input.inbound.sessionId, input.inbound.text);
    if (directProgressStatus) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing progress-query directive");
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting progress-query response");
      await this.recordConversation(input.inbound.sessionId, "outbound", directProgressStatus, {
        source: "gateway",
        channel: "internal",
        kind: "job",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          progressQuery: true
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: directProgressStatus
      };
    }

    return null;
  }

  private async handlePlannerPrimaryRoutes(input: {
    inbound: { sessionId: string; text: string };
    plan?: PlannerDecision;
    runId?: string;
    authSessionId: string;
    authPreference: LlmAuthPreference;
    markPhase: (
      phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
      message?: string,
      details?: Record<string, unknown>
    ) => Promise<void>;
    markRunNote: (message: string, details?: Record<string, unknown>) => Promise<void>;
    recordPlannerTrace: (chosenAction: string, extra?: Record<string, unknown>) => Promise<void>;
  }): Promise<InboundHandleResult | null> {
    const { plan } = input;
    if (!plan) {
      return null;
    }

    if (plan.intent === "clarify") {
      await input.recordPlannerTrace("ask_clarification");
      const question = plan.question?.trim() || "Can you clarify what output you want first?";
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting clarification");
      await this.recordConversation(input.inbound.sessionId, "outbound", question, {
        source: "gateway",
        channel: "internal",
        kind: "chat",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          plannerIntent: plan.intent,
          plannerConfidence: plan.confidence,
          plannerReason: plan.reason
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: question
      };
    }

    if (plan.intent === "status_query") {
      const progressStatus = await this.latestJobStatusMessage(input.inbound.sessionId);
      await input.recordPlannerTrace("reply_progress_status");
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting status-query response");
      await this.recordConversation(input.inbound.sessionId, "outbound", progressStatus, {
        source: "gateway",
        channel: "internal",
        kind: "job",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          progressQuery: true,
          plannerIntent: plan.intent,
          plannerConfidence: plan.confidence,
          plannerReason: plan.reason
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: progressStatus
      };
    }

    const plannerLocalOpsRoute = await this.routeNaturalLanguageLocalOpsRequest(
      input.inbound.sessionId,
      plan.query?.trim() || input.inbound.text,
      input.authSessionId,
      input.authPreference
    );
    if (plannerLocalOpsRoute) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing planner local operation request", {
        plannerAction: plannerLocalOpsRoute.plannerAction,
        ...(plannerLocalOpsRoute.details ?? {})
      });
      await input.recordPlannerTrace(plannerLocalOpsRoute.plannerAction, plannerLocalOpsRoute.details);
      await input.markRunNote(plannerLocalOpsRoute.note, plannerLocalOpsRoute.details);
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting planner local-ops response");
      await this.recordConversation(input.inbound.sessionId, "outbound", plannerLocalOpsRoute.response, {
        source: "gateway",
        channel: "internal",
        kind: "command",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          plannerIntent: plan.intent,
          plannerConfidence: plan.confidence,
          plannerReason: plan.reason,
          localOps: true,
          plannerAction: plannerLocalOpsRoute.plannerAction,
          ...(plannerLocalOpsRoute.details ?? {})
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: plannerLocalOpsRoute.response
      };
    }

    const forcedWorkerDelegation = this.shouldForceWorkerDelegation(plan);
    if ((plan.needsWorker || forcedWorkerDelegation) && plan.query?.trim()) {
      if (plan.sendAttachment) {
        const runSpecRunId = input.runId ?? randomUUID();
        const runSpec = this.buildWebToFileRunSpec({
          runSpecRunId,
          query: plan.query.trim(),
          provider: plan.provider ?? "auto",
          fileFormat: plan.fileFormat ?? "md",
          fileName: plan.fileName,
          sessionId: input.inbound.sessionId,
          authSessionId: input.authSessionId
        });
        if (this.requiresApproval("file_write", { sessionId: input.inbound.sessionId, authSessionId: input.authSessionId })) {
          const approvalResponse = await this.requestNextRunSpecApprovalIfNeeded({
            sessionId: input.inbound.sessionId,
            runSpecRunId,
            runSpec,
            approvedStepIds: [],
            authSessionId: input.authSessionId,
            authPreference: input.authPreference,
          reason: `planner_${plan.reason}`
        });
          const response =
            approvalResponse ??
            "Approval flow is configured but no approval checkpoint was found for this run.";
          await input.recordPlannerTrace("request_approval_web_to_file_send");
          await runPersistPhase({ markPhase: input.markPhase }, "Persisting planner approval request");
          await this.recordConversation(input.inbound.sessionId, "outbound", response, {
            source: "gateway",
            channel: "internal",
            kind: "command",
            metadata: {
              authSessionId: input.authSessionId,
              runId: input.runId,
              plannerIntent: plan.intent,
              plannerConfidence: plan.confidence,
              plannerReason: plan.reason
            }
          });
          return {
            accepted: true,
            mode: "chat",
            response
          };
        }

        await runRoutePhase({ markPhase: input.markPhase }, "Routing planner research-to-file task to worker queue");
        const job = await this.enqueueLongTaskJob(input.inbound.sessionId, {
          taskType: "web_to_file",
          query: plan.query.trim(),
          provider: plan.provider ?? this.capabilityPolicy.webSearchProvider,
          authSessionId: input.authSessionId,
          authPreference: input.authPreference,
          reason: `planner_${plan.reason}`,
          fileFormat: plan.fileFormat ?? "md",
          fileName: plan.fileName,
          runSpecRunId
        });
        await input.recordPlannerTrace("enqueue_worker_web_to_file", { jobId: job.id, taskType: "web_to_file" });
        await input.markRunNote("Planner delegated research-to-file to worker", { jobId: job.id, reason: plan.reason });
        const response = `Queued research + document delivery as job ${job.id}. I will share progress and send the file when ready.`;
        await runPersistPhase({ markPhase: input.markPhase }, "Persisting worker delegation response");
        await this.recordConversation(input.inbound.sessionId, "outbound", response, {
          source: "gateway",
          channel: "internal",
          kind: "job",
          metadata: {
            authSessionId: input.authSessionId,
            runId: input.runId,
            plannerIntent: plan.intent,
            plannerConfidence: plan.confidence,
            plannerReason: plan.reason,
            jobId: job.id
          }
        });
        return {
          accepted: true,
          mode: "async-job",
          response,
          jobId: job.id
        };
      }

      await runRoutePhase({ markPhase: input.markPhase }, "Routing planner research to worker queue");
      const job = await this.enqueueLongTaskJob(input.inbound.sessionId, {
        taskType: "agentic_turn",
        query: plan.query.trim(),
        provider: plan.provider ?? this.capabilityPolicy.webSearchProvider,
        authSessionId: input.authSessionId,
        authPreference: input.authPreference,
        reason: `planner_${plan.reason}`
      });
      await input.recordPlannerTrace("enqueue_worker_agentic_turn", {
        jobId: job.id,
        taskType: "agentic_turn",
        forcedByIntentOrSideEffect: forcedWorkerDelegation
      });
      await input.markRunNote("Planner delegated to worker", { jobId: job.id, reason: plan.reason });
      const response = `Queued research as job ${job.id}. I will share concise progress and final results here.`;
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting worker delegation response");
      await this.recordConversation(input.inbound.sessionId, "outbound", response, {
        source: "gateway",
        channel: "internal",
        kind: "job",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          plannerIntent: plan.intent,
          plannerConfidence: plan.confidence,
          plannerReason: plan.reason,
          jobId: job.id
        }
      });
      return {
        accepted: true,
        mode: "async-job",
        response,
        jobId: job.id
      };
    }

    return null;
  }

  private shouldForceWorkerDelegation(plan: PlannerDecision): boolean {
    const hasQuery = Boolean(plan.query?.trim());
    if (!hasQuery) {
      return false;
    }
    // Gateway-level safety net so misclassified planner output does not route side-effect/research asks into chat-turn.
    if (plan.intent === "web_research") {
      return true;
    }
    if (plan.sendAttachment === true) {
      return true;
    }
    return false;
  }

  private shouldDelegateToWorker(plan: PlannerDecision): boolean {
    if (!plan.query?.trim()) {
      return false;
    }
    if (plan.intent === "status_query") {
      return false;
    }
    return plan.needsWorker || this.shouldForceWorkerDelegation(plan);
  }

  private describeWorkerDelegationDecision(plan: PlannerDecision): {
    willDelegateWorker: boolean;
    forcedByPolicy: boolean;
    reason: string;
  } {
    const hasQuery = Boolean(plan.query?.trim());
    const forcedByPolicy = this.shouldForceWorkerDelegation(plan) && !plan.needsWorker;
    const willDelegateWorker = this.shouldDelegateToWorker(plan);

    let reason = "chat_inline";
    if (!hasQuery) {
      reason = "no_query";
    } else if (plan.intent === "status_query") {
      reason = "status_query_inline";
    } else if (forcedByPolicy && plan.intent === "web_research") {
      reason = "forced_web_research";
    } else if (forcedByPolicy && plan.sendAttachment) {
      reason = "forced_attachment_side_effect";
    } else if (plan.needsWorker) {
      reason = "planner_requested_worker";
    }

    return { willDelegateWorker, forcedByPolicy, reason };
  }

  private async handlePlannerFallbackRoutes(input: {
    inbound: { sessionId: string; text: string };
    runId?: string;
    authSessionId: string;
    authPreference: LlmAuthPreference;
    markPhase: (
      phase: "normalize" | "session" | "directives" | "plan" | "policy" | "route" | "persist" | "dispatch",
      message?: string,
      details?: Record<string, unknown>
    ) => Promise<void>;
    markRunNote: (message: string, details?: Record<string, unknown>) => Promise<void>;
    recordPlannerTrace: (chosenAction: string, extra?: Record<string, unknown>) => Promise<void>;
  }): Promise<InboundHandleResult> {
    const command = parseCommand(input.inbound.text);
    if (command) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing command execution", { command: command.kind });
      await input.recordPlannerTrace("execute_command", { command: command.kind });
      const response = await this.executeCommand(input.inbound.sessionId, command, input.authSessionId, input.authPreference);
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting command response", {
        command: command.kind
      });
      await this.recordConversation(input.inbound.sessionId, "outbound", response, {
        source: "gateway",
        channel: "internal",
        kind: "command",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response
      };
    }

    const implicitApproval = this.parseImplicitApprovalDecision(input.inbound.text);
    if (implicitApproval) {
      const decisionResult = await this.executeImplicitApprovalDecision(
        input.inbound.sessionId,
        implicitApproval,
        input.authSessionId,
        input.authPreference
      );
      if (decisionResult.handled) {
        await runRoutePhase({ markPhase: input.markPhase }, "Routing implicit approval decision", {
          decision: implicitApproval
        });
        await input.recordPlannerTrace("resolve_approval_decision", { decision: implicitApproval });
        await runPersistPhase({ markPhase: input.markPhase }, "Persisting implicit approval response");
        await this.recordConversation(input.inbound.sessionId, "outbound", decisionResult.response, {
          source: "gateway",
          channel: "internal",
          kind: "command",
          metadata: {
            authSessionId: input.authSessionId,
            runId: input.runId
          }
        });
        return {
          accepted: true,
          mode: "chat",
          response: decisionResult.response
        };
      }
    }

    const progressStatus = await this.answerProgressQuery(input.inbound.sessionId, input.inbound.text);
    if (progressStatus) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing progress-query fallback");
      await input.recordPlannerTrace("reply_progress_status_fallback");
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting progress fallback response");
      await this.recordConversation(input.inbound.sessionId, "outbound", progressStatus, {
        source: "gateway",
        channel: "internal",
        kind: "job",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          progressQuery: true
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: progressStatus
      };
    }

    const localOpsRoute = await this.routeNaturalLanguageLocalOpsRequest(
      input.inbound.sessionId,
      input.inbound.text,
      input.authSessionId,
      input.authPreference
    );
    if (localOpsRoute) {
      await runRoutePhase({ markPhase: input.markPhase }, "Routing natural-language local operation request", {
        plannerAction: localOpsRoute.plannerAction,
        ...(localOpsRoute.details ?? {})
      });
      await input.recordPlannerTrace(localOpsRoute.plannerAction, localOpsRoute.details);
      await input.markRunNote(localOpsRoute.note, localOpsRoute.details);
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting local-ops routing response");
      await this.recordConversation(input.inbound.sessionId, "outbound", localOpsRoute.response, {
        source: "gateway",
        channel: "internal",
        kind: "command",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          localOps: true,
          plannerAction: localOpsRoute.plannerAction,
          ...(localOpsRoute.details ?? {})
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response: localOpsRoute.response
      };
    }

    const routed = await this.routeLongTaskIfNeeded(
      input.inbound.sessionId,
      input.inbound.text,
      input.authSessionId,
      input.authPreference
    );
    if (routed) {
      const routedToWorker = Boolean(routed.jobId);
      await runRoutePhase(
        { markPhase: input.markPhase },
        routedToWorker ? "Routing heuristic long task to worker" : "Routing heuristic approval request",
        {
          taskType: routed.taskType,
          reason: routed.reason
        }
      );
      await input.recordPlannerTrace(routedToWorker ? "enqueue_heuristic_long_task" : "request_approval_heuristic_long_task", {
        jobId: routed.jobId || undefined,
        taskType: routed.taskType
      });
      await input.markRunNote(routedToWorker ? "Heuristic delegation to worker" : "Heuristic approval requested", {
        jobId: routed.jobId || undefined,
        reason: routed.reason
      });
      await runPersistPhase({ markPhase: input.markPhase }, "Persisting heuristic worker delegation response");
      await this.recordConversation(input.inbound.sessionId, "outbound", routed.response, {
        source: "gateway",
        channel: "internal",
        kind: routedToWorker ? "job" : "command",
        metadata: {
          authSessionId: input.authSessionId,
          runId: input.runId,
          routedTaskType: routed.taskType,
          reason: routed.reason,
          jobId: routed.jobId || undefined
        }
      });
      return {
        accepted: true,
        mode: routedToWorker ? "async-job" : "chat",
        response: routed.response,
        jobId: routed.jobId || undefined
      };
    }

    await runRoutePhase({ markPhase: input.markPhase }, "Running local chat turn");
    await input.recordPlannerTrace("run_chat_turn");
    const response = await this.executeChatTurn(input.authSessionId, input.inbound.text, input.authPreference);
    await runPersistPhase({ markPhase: input.markPhase }, "Persisting chat response");
    await this.recordConversation(input.inbound.sessionId, "outbound", response, {
      source: "gateway",
      channel: "internal",
      kind: "chat",
      metadata: {
        authSessionId: input.authSessionId,
        runId: input.runId,
        authPreference: input.authPreference
      }
    });
    return {
      accepted: true,
      mode: "chat",
      response
    };
  }

  async getJob(jobId: string) {
    return this.store.getJob(jobId);
  }

  async cancelJob(jobId: string) {
    return this.store.cancelJob(jobId);
  }

  async retryJob(jobId: string) {
    return this.store.retryJob(jobId);
  }

  async listPendingApprovals(
    sessionId: string,
    limit = 10
  ): Promise<Array<{ token: string; action: string; createdAt: string; expiresAt: string; payloadPreview: string }>> {
    if (!this.approvalStore) {
      return [];
    }

    const pending = await this.approvalStore.listBySession(sessionId, limit);
    return pending.map((item) => ({
      token: item.token,
      action: item.action,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      payloadPreview: this.buildApprovalPayloadPreview(item.payload)
    }));
  }

  async handleBaileysInbound(payload: unknown, dedupeStore: MessageDedupeStore): Promise<{
    accepted: boolean;
    duplicate: boolean;
    mode?: "chat" | "async-job";
    response?: string;
    jobId?: string;
    providerMessageId?: string;
  }> {
    const normalized = normalizeBaileysInbound(payload);
    const duplicate = await dedupeStore.isDuplicateAndMark(normalized.dedupeKey);

    if (duplicate) {
      await this.recordConversation(normalized.normalized.sessionId, "system", "Dropped duplicate inbound message", {
        source: "whatsapp",
        channel: "baileys",
        kind: "dedupe",
        metadata: { providerMessageId: normalized.providerMessageId }
      });
      return {
        accepted: true,
        duplicate: true,
        providerMessageId: normalized.providerMessageId
      };
    }

    const result = await this.handleInbound(normalized.normalized);
    return {
      ...result,
      duplicate: false,
      providerMessageId: normalized.providerMessageId
    };
  }

  private async executeCommand(
    sessionId: string,
    command: ParsedCommand,
    authSessionId = sessionId,
    authPreference: LlmAuthPreference = "auto"
  ): Promise<string> {
    switch (command.kind) {
      case "remind_add": {
        if (!this.reminderStore) {
          return "Reminders are not configured.";
        }

        const parsedDate = new Date(command.remindAt);
        if (Number.isNaN(parsedDate.getTime())) {
          return "Invalid reminder time. Use ISO format, e.g. /remind 2026-02-23T09:00:00Z call mom";
        }

        const reminder = await this.reminderStore.add(sessionId, command.text, parsedDate.toISOString());
        return `Reminder created (${reminder.id}) for ${reminder.remindAt}`;
      }

      case "remind_list": {
        if (!this.reminderStore) {
          return "Reminders are not configured.";
        }

        const reminders = await this.reminderStore.listBySession(sessionId);
        if (reminders.length === 0) {
          return "No pending reminders.";
        }

        const lines = reminders.slice(0, 10).map((item) => `- ${item.id}: ${item.text} @ ${item.remindAt}`);
        return `Pending reminders:\n${lines.join("\n")}`;
      }

      case "calendar_add": {
        if (!this.reminderStore) {
          return "Calendar is not configured.";
        }

        const parsedDate = new Date(command.startsAt);
        if (Number.isNaN(parsedDate.getTime())) {
          return "Invalid calendar time. Use ISO format, e.g. /calendar add 2026-02-23T09:00:00Z team sync";
        }

        const event = await this.reminderStore.add(sessionId, command.title, parsedDate.toISOString());
        await this.recordMemoryCheckpoint(sessionId, {
          class: "todo",
          source: "calendar_add",
          summary: `Calendar event scheduled: ${command.title}`,
          details: `${event.id} @ ${event.remindAt}`,
          dedupeKey: `calendar_add:${sessionId}:${event.id}`
        });
        return `Calendar event created (${event.id}) for ${event.remindAt}: ${event.text}`;
      }

      case "calendar_list": {
        if (!this.reminderStore) {
          return "Calendar is not configured.";
        }

        const events = await this.reminderStore.listBySession(sessionId);
        if (events.length === 0) {
          return "No upcoming calendar events.";
        }
        const lines = events.slice(0, 10).map((item) => `- ${item.id}: ${item.text} @ ${item.remindAt}`);
        return `Upcoming calendar events:\n${lines.join("\n")}`;
      }

      case "calendar_cancel": {
        if (!this.reminderStore) {
          return "Calendar is not configured.";
        }

        const cancelled = await this.reminderStore.cancel(sessionId, command.id);
        if (!cancelled) {
          return `Calendar event not found: ${command.id}`;
        }
        if (cancelled.status !== "cancelled") {
          return `Calendar event ${cancelled.id} is already ${cancelled.status}.`;
        }

        await this.recordMemoryCheckpoint(sessionId, {
          class: "decision",
          source: "calendar_cancel",
          summary: `Calendar event cancelled: ${cancelled.text}`,
          details: `${cancelled.id} @ ${cancelled.remindAt}`,
          dedupeKey: `calendar_cancel:${sessionId}:${cancelled.id}`
        });
        return `Calendar event cancelled: ${cancelled.id}`;
      }

      case "task_add": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const task = await this.taskStore.add(sessionId, command.text);
        await this.recordMemoryCheckpoint(sessionId, {
          class: "todo",
          source: "task_add",
          summary: `Task added: ${task.text}`,
          dedupeKey: `task_add:${sessionId}:${task.id}`
        });
        return `Task added (${task.id}): ${task.text}`;
      }

      case "note_add": {
        if (!this.noteStore) {
          return "Notes are not configured.";
        }

        const note = await this.noteStore.add(sessionId, command.text);
        return `Note added (${note.id}): ${note.text}`;
      }

      case "note_list": {
        if (!this.noteStore) {
          return "Notes are not configured.";
        }

        const notes = await this.noteStore.listBySession(sessionId);
        if (notes.length === 0) {
          return "No saved notes.";
        }

        return `Notes:\n${notes
          .slice(-10)
          .map((item) => `- ${item.id}: ${item.text}`)
          .join("\n")}`;
      }

      case "task_list": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const tasks = await this.taskStore.listOpen(sessionId);
        if (tasks.length === 0) {
          return "No open tasks.";
        }

        return `Open tasks:\n${tasks.slice(0, 10).map((item) => `- ${item.id}: ${item.text}`).join("\n")}`;
      }

      case "task_done": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const done = await this.taskStore.markDone(sessionId, command.id);
        if (!done) {
          return `Task not found: ${command.id}`;
        }

        await this.recordMemoryCheckpoint(sessionId, {
          class: "decision",
          source: "task_done",
          summary: `Task completed: ${done.text}`,
          dedupeKey: `task_done:${sessionId}:${done.id}`
        });
        return `Task completed: ${done.id}`;
      }

      case "job_status": {
        const job = await this.store.getJob(command.id);
        if (!job) {
          return `Job not found: ${command.id}`;
        }

        return `Job ${job.id} is ${job.status}`;
      }

      case "job_cancel": {
        const job = await this.store.cancelJob(command.id);
        if (!job) {
          return `Job not found: ${command.id}`;
        }

        return `Job ${job.id} is ${job.status}`;
      }

      case "job_retry": {
        const job = await this.store.retryJob(command.id);
        if (!job) {
          return `Job retry not available for ${command.id} (only failed/cancelled jobs can be retried).`;
        }

        await this.queueJobNotification(sessionId, job.id, "queued", `Job ${job.id} is queued (retry of ${command.id})`);
        return `Retry queued as job ${job.id}`;
      }

      case "auth_connect": {
        if (this.codexAuthService) {
          const started = await this.codexAuthService.startLogin(this.codexLoginMode, this.codexApiKey);
          if (started.authorizationUrl) {
            return `Open this link to connect Codex (${started.mode}): ${started.authorizationUrl}`;
          }
          return `Codex auth login started (${started.mode}).`;
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const started = await this.oauthService.startOpenAiConnect(authSessionId);
        return `Open this link to connect OpenAI (${started.mode}): ${started.authorizationUrl}`;
      }

      case "auth_status": {
        if (this.codexAuthService) {
          const status = await this.codexAuthService.readStatus(false);
          if (!status.connected) {
            return "Codex auth is not connected.";
          }

          const identity = status.email ? `${status.email}` : "session";
          const plan = status.planType ? ` (${status.planType})` : "";
          return `Codex auth connected as ${identity}${plan}.`;
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const status = await this.oauthService.statusOpenAi(authSessionId);
        if (!status.connected) {
          return "OpenAI OAuth is not connected for this session.";
        }

        const expiry = status.expiresAt ? `, expires ${status.expiresAt}` : "";
        return `OpenAI OAuth connected (${status.mode}, ${status.storageScheme}${expiry}).`;
      }

      case "auth_limits": {
        if (!this.codexAuthService) {
          return "Rate limits are available when Codex auth is configured.";
        }

        const limits = await this.codexAuthService.readRateLimits();
        const primary = limits.rateLimits?.primary;
        if (!primary) {
          return "Codex rate limits unavailable.";
        }

        const used = `${Math.round(primary.usedPercent * 100) / 100}%`;
        const reset = primary.resetsAt ? new Date(primary.resetsAt * 1000).toISOString() : "unknown";
        const label = limits.rateLimits?.limitName ?? limits.rateLimits?.limitId ?? "default";
        return `Codex rate limit (${label}): used ${used}, resets at ${reset}`;
      }

      case "auth_disconnect": {
        if (this.codexAuthService) {
          await this.codexAuthService.logout();
          return "Codex auth disconnected.";
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const removed = await this.oauthService.disconnectOpenAi(authSessionId);
        return removed ? "OpenAI OAuth token removed for this session." : "No OpenAI OAuth token found for this session.";
      }

      case "policy_status": {
        return [
          "Capability policy:",
          `- workspaceDir: ${this.capabilityPolicy.workspaceDir}`,
          `- approvalMode: ${this.capabilityPolicy.approvalMode}`,
          `- approvalDefault: ${String(this.capabilityPolicy.approvalDefault)}`,
          `- webSearch: enabled=${String(this.capabilityPolicy.webSearchEnabled)}, requireApproval=${String(this.capabilityPolicy.webSearchRequireApproval)}, provider=${this.capabilityPolicy.webSearchProvider}`,
          `- fileWrite: enabled=${String(this.capabilityPolicy.fileWriteEnabled)}, requireApproval=${String(this.capabilityPolicy.fileWriteRequireApproval)}, mode=${this.capabilityPolicy.fileWriteApprovalMode}, scope=${this.capabilityPolicy.fileWriteApprovalScope}, notesOnly=${String(this.capabilityPolicy.fileWriteNotesOnly)}, notesDir=${this.capabilityPolicy.fileWriteNotesDir}`,
          `- shell: enabled=${String(this.capabilityPolicy.shellEnabled)}, timeoutMs=${this.capabilityPolicy.shellTimeoutMs}, maxOutputChars=${this.capabilityPolicy.shellMaxOutputChars}`,
          `- shellAllowedDirs: ${this.capabilityPolicy.shellAllowedDirs.join(", ")}`,
          `- wasm: enabled=${String(this.capabilityPolicy.wasmEnabled)}`
        ].join("\n");
      }

      case "approval_pending": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }
        const pending = await this.approvalStore.listBySession(sessionId, 5);
        if (pending.length === 0) {
          return "No pending approvals for this session.";
        }
        const lines = pending.map((item) => {
          const preview = this.buildApprovalPayloadPreview(item.payload);
          return `- ${item.action} token=${item.token} expires=${item.expiresAt}${preview ? ` payload=${preview}` : ""}`;
        });
        return [
          `Pending approvals (${pending.length}):`,
          ...lines,
          "Reply yes/no for the latest request. Use approve <token> or reject <token> to resolve a specific pending request."
        ].join("\n");
      }

      case "supervisor_status": {
        if (!this.supervisorStore) {
          return "Supervisor is not configured.";
        }
        const supervisor = await this.supervisorStore.get(command.id);
        if (!supervisor) {
          return `Supervisor run not found: ${command.id}`;
        }
        return this.supervisorStore.summarize(supervisor);
      }

      case "supervise_web": {
        if (!this.capabilityPolicy.webSearchEnabled) {
          return "Web search is disabled by policy.";
        }
        if (!this.supervisorStore) {
          return "Supervisor is not configured.";
        }

        const initialProviders: Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata"> =
          command.providers && command.providers.length > 0
            ? command.providers
            : ["searxng", "openai", "brave", "perplexity", "brightdata"];
        const providers = [...new Set(initialProviders)].slice(0, 6);
        if (providers.length === 0) {
          return "No valid providers were selected for supervision.";
        }

        const maxRetries = command.maxRetries ?? 1;
        const timeBudgetMs = command.timeBudgetMs ?? 120_000;
        const tokenBudget = command.tokenBudget ?? 8_000;
        const supervisor = await this.supervisorStore.createWebFanout({
          sessionId,
          query: command.query,
          children: providers.map((provider) => ({
            provider,
            maxRetries,
            timeBudgetMs,
            tokenBudget
          }))
        });

        const childJobs: string[] = [];
        for (const provider of providers) {
          const job = await this.store.createJob({
            type: "stub_task",
            payload: {
              taskType: "web_search",
              query: command.query,
              provider,
              sessionId,
              authSessionId,
              authPreference,
              supervisorId: supervisor.id,
              maxRetries,
              timeBudgetMs,
              tokenBudget
            },
            priority: 5
          });
          childJobs.push(job.id);
          await this.supervisorStore.assignChildJob(supervisor.id, provider, job.id);
        }

        return `Supervisor ${supervisor.id} queued ${childJobs.length} child jobs (${providers.join(", ")}). Use /supervisor status ${supervisor.id}.`;
      }

      case "web_search": {
        const policy = this.evaluateToolPolicy("web.search", { sessionId, authSessionId });
        if (!policy.allowed) {
          return policy.reason ?? "Web search is disabled by policy.";
        }

        const provider = command.provider ?? this.capabilityPolicy.webSearchProvider;
        const job = await this.enqueueLongTaskJob(sessionId, {
          taskType: "web_search",
          query: command.query,
          provider,
          authSessionId,
          authPreference,
          reason: "explicit_web_command"
        });
        return `Queued web search as job ${job.id}. I will post progress updates here.`;
      }

      case "file_write": {
        const policy = this.evaluateToolPolicy("file.write", { sessionId, authSessionId });
        if (!policy.allowed) {
          return policy.reason ?? "File write is disabled by policy. Use /note add for durable notes.";
        }

        const resolved = this.resolveWorkspacePath(command.relativePath);
        if (!resolved.ok) {
          return resolved.error;
        }

        if (policy.requiresApproval) {
          if (!this.approvalStore) {
            return "Approvals are not configured.";
          }

          const approval = await this.approvalStore.create(sessionId, "file_write", {
            relativePath: command.relativePath,
            text: command.text,
            authSessionId
          });
          return `Approval required for file write. Reply yes or no. Optional explicit token: approve ${approval.token}`;
        }

        return this.executeFileWrite(resolved.absolutePath, command.text);
      }

      case "file_send": {
        const policy = this.evaluateToolPolicy("file.send", { sessionId, authSessionId });
        if (!policy.allowed) {
          return policy.reason ?? "File send is disabled by policy.";
        }
        const resolved = this.resolveWorkspacePath(command.relativePath);
        if (!resolved.ok) {
          return resolved.error;
        }
        const attachmentPolicy = this.validateAttachmentPath(resolved.absolutePath);
        if (!attachmentPolicy.ok) {
          return attachmentPolicy.error;
        }

        if (policy.requiresApproval) {
          if (!this.approvalStore) {
            return "Approvals are not configured.";
          }

          const approval = await this.approvalStore.create(sessionId, "file_send", {
            relativePath: command.relativePath,
            caption: command.caption,
            authSessionId
          });
          return `Approval required for file send. Reply yes or no. Optional explicit token: approve ${approval.token}`;
        }

        return this.executeFileSend(sessionId, resolved.absolutePath, command.caption);
      }

      case "shell_exec": {
        if (!isSandboxTargetEnabled("shell.exec", this.buildSandboxPolicyConfig())) {
          return "Shell execution is disabled by sandbox policy.";
        }
        const policy = this.evaluateToolPolicy("shell.exec", { sessionId, authSessionId });
        if (!policy.allowed) {
          return policy.reason ?? "Shell execution is disabled by policy.";
        }
        const resolvedCwd = this.resolveShellCwd(command.cwd);
        if (!resolvedCwd.ok) {
          return resolvedCwd.error;
        }
        const shellPolicy = this.evaluateShellCommandPolicy(command.command);
        if (shellPolicy.blocked) {
          if (!this.approvalStore) {
            return `Shell command blocked by policy (${shellPolicy.ruleId}). Approvals are not configured for override.`;
          }
          const approval = await this.approvalStore.create(sessionId, "shell_exec_override", {
            command: command.command,
            cwd: resolvedCwd.cwd,
            blockedRuleId: shellPolicy.ruleId,
            authSessionId
          });
          return `Shell command blocked by policy (${shellPolicy.ruleId}). To override once, reply: approve shell ${approval.token}`;
        }

        await this.recordToolUsage(sessionId, "shell.exec", {
          command: command.command,
          cwd: resolvedCwd.cwd,
          override: false
        });
        if (policy.requiresApproval) {
          if (!this.approvalStore) {
            return "Approvals are not configured.";
          }
          const approval = await this.approvalStore.create(sessionId, "shell_exec", {
            command: command.command,
            cwd: resolvedCwd.cwd,
            authSessionId
          });
          return [
            "Approval required for shell command.",
            `- cwd: ${resolvedCwd.cwd}`,
            `- command: ${command.command}`,
            `Reply yes or no. Optional explicit token: approve ${approval.token}`
          ].join("\n");
        }
        return this.executeShellCommand(command.command, resolvedCwd.cwd);
      }

      case "side_effect_send": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }

        const approval = await this.approvalStore.create(sessionId, "send_text", { text: command.text });
        return `Approval required for side-effect action. Reply yes or no. Optional explicit token: approve ${approval.token}`;
      }

      case "approve": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }

        const approval = await this.approvalStore.consume(sessionId, command.token);
        if (!approval) {
          return `Approval token invalid or expired: ${command.token}`;
        }
        return this.executeApprovedAction(approval, sessionId, authSessionId, authPreference);
      }

      case "reject": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }
        const approval = await this.approvalStore.consume(sessionId, command.token);
        if (!approval) {
          return `Approval token invalid or expired: ${command.token}`;
        }
        await this.recordMemoryCheckpoint(sessionId, {
          class: "decision",
          source: "approval_reject",
          summary: `Rejected action: ${approval.action}`,
          dedupeKey: `approval_reject:${sessionId}:${approval.token}`
        });
        return `Rejected action: ${approval.action}`;
      }
    }
  }

  private parseImplicitApprovalDecision(rawText: string): ImplicitApprovalDecision | null {
    const value = rawText.trim().toLowerCase();
    if (!value) {
      return null;
    }
    if (value === "yes" || value === "y" || value === "approve" || value === "/approve") {
      return "approve_latest";
    }
    if (value === "no" || value === "n" || value === "reject" || value === "/reject") {
      return "reject_latest";
    }
    return null;
  }

  private async executeImplicitApprovalDecision(
    sessionId: string,
    decision: ImplicitApprovalDecision,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<{ handled: boolean; response: string }> {
    if (!this.approvalStore) {
      return { handled: false, response: "" };
    }

    const pending = await this.approvalStore.peekLatest(sessionId);
    if (!pending) {
      return { handled: false, response: "" };
    }

    if (decision === "reject_latest") {
      const discarded = await this.approvalStore.discardLatest(sessionId);
      if (!discarded) {
        return { handled: false, response: "" };
      }
      await this.recordMemoryCheckpoint(sessionId, {
        class: "decision",
        source: "approval_reject",
        summary: `Rejected action: ${discarded.action}`,
        dedupeKey: `approval_reject:${sessionId}:${discarded.token}`
      });
      return { handled: true, response: `Rejected action: ${discarded.action}` };
    }

    const approval = await this.approvalStore.consumeLatest(sessionId);
    if (!approval) {
      return { handled: false, response: "" };
    }
    const response = await this.executeApprovedAction(approval, sessionId, authSessionId, authPreference);
    return { handled: true, response };
  }

  private async handlePagingRequest(sessionId: string, rawText: string): Promise<string | null> {
    if (!this.pagedResponseStore) {
      return null;
    }
    const value = rawText.trim().toLowerCase();
    if (value !== "#next" && value !== "next") {
      return null;
    }

    const next = await this.pagedResponseStore.popNext(sessionId);
    if (!next) {
      return "No queued paged response is available. Ask a new question or run another long task.";
    }
    const suffix = next.remaining > 0 ? `\n\nReply #next for more (${next.remaining} remaining).` : "";
    return `${next.page}${suffix}`;
  }

  private async answerProgressQuery(sessionId: string, rawText: string): Promise<string | null> {
    if (!this.looksLikeProgressQuery(rawText)) {
      return null;
    }
    return this.latestJobStatusMessage(sessionId);
  }

  private async latestJobStatusMessage(sessionId: string): Promise<string> {
    const active = await this.findLatestActiveJob(sessionId);
    if (!active) {
      return "No active long-running job for this session.";
    }

    const progress = active.progress?.message ? ` | progress: ${String(active.progress.message)}` : "";
    return `Latest job ${active.id} is ${active.status}${progress}`;
  }

  private async routeNaturalLanguageLocalOpsRequest(
    sessionId: string,
    rawText: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<LocalOpsRouteResult | null> {
    if (!this.shouldAttemptLocalOpsRouting(rawText)) {
      return null;
    }

    if (!isSandboxTargetEnabled("shell.exec", this.buildSandboxPolicyConfig())) {
      return {
        response: "I detected a local-ops request, but shell.exec is disabled by sandbox policy.",
        plannerAction: "local_ops_disabled_sandbox",
        note: "Local-ops request blocked by sandbox policy"
      };
    }

    const toolPolicy = this.evaluateToolPolicy("shell.exec", { sessionId, authSessionId });
    if (!toolPolicy.allowed || !this.capabilityPolicy.shellEnabled) {
      return {
        response:
          "I detected a local-ops request, but shell execution is currently disabled. Enable shell policy first, then retry.",
        plannerAction: "local_ops_disabled_policy",
        note: "Local-ops request blocked by shell policy"
      };
    }

    if (!this.approvalStore) {
      return {
        response: "I detected a local-ops request, but approvals are not configured.",
        plannerAction: "local_ops_missing_approval_store",
        note: "Local-ops request could not be routed because approval store is unavailable"
      };
    }

    const proposal = await this.proposeLocalOps(rawText, authSessionId, authPreference);
    if (!proposal) {
      return null;
    }

    if (proposal.needsClarification || !proposal.command || proposal.confidence < 0.62) {
      const question =
        proposal.question?.trim() ||
        "I can run this locally once approved. Which exact command should I run, and in which directory?";
      return {
        response: question,
        plannerAction: "local_ops_clarify",
        note: "Local-ops proposal required clarification",
        details: {
          confidence: proposal.confidence
        }
      };
    }

    const resolvedCwd = this.resolveShellCwd(proposal.cwd);
    if (!resolvedCwd.ok) {
      return {
        response: `${resolvedCwd.error}\nPlease provide a path under the configured shell allowed roots.`,
        plannerAction: "local_ops_invalid_cwd",
        note: "Local-ops proposal rejected due to cwd outside allowed scope",
        details: {
          proposedCwd: proposal.cwd ?? ""
        }
      };
    }

    const shellPolicy = this.evaluateShellCommandPolicy(proposal.command);
    if (shellPolicy.blocked) {
      const approval = await this.approvalStore.create(sessionId, "shell_exec_override", {
        command: proposal.command,
        cwd: resolvedCwd.cwd,
        blockedRuleId: shellPolicy.ruleId,
        authSessionId,
        source: "planner_local_ops",
        reason: proposal.reason ?? "policy_blocked"
      });
      return {
        response: [
          `Proposed command is blocked by shell policy (${shellPolicy.ruleId}).`,
          `- cwd: ${resolvedCwd.cwd}`,
          `- command: ${proposal.command}`,
          `Reply yes/no, or explicit override: approve shell ${approval.token}`
        ].join("\n"),
        plannerAction: "request_approval_local_ops_shell_override",
        note: "Local-ops proposal blocked by command policy and queued for explicit override approval",
        details: {
          confidence: proposal.confidence,
          blockedRuleId: shellPolicy.ruleId,
          cwd: resolvedCwd.cwd
        }
      };
    }

    const approval = await this.approvalStore.create(sessionId, "shell_exec", {
      command: proposal.command,
      cwd: resolvedCwd.cwd,
      authSessionId,
      source: "planner_local_ops",
      reason: proposal.reason ?? "local_ops_request"
    });

    return {
      response: [
        "Local operation ready for approval.",
        `- cwd: ${resolvedCwd.cwd}`,
        `- command: ${proposal.command}`,
        "Reply yes/no to approve or reject.",
        `Optional explicit token: approve ${approval.token}`
      ].join("\n"),
      plannerAction: "request_approval_local_ops_shell_exec",
      note: "Local-ops proposal queued for shell approval",
      details: {
        confidence: proposal.confidence,
        cwd: resolvedCwd.cwd
      }
    };
  }

  private shouldAttemptLocalOpsRouting(rawText: string): boolean {
    const text = rawText.trim().toLowerCase();
    if (!text || text.startsWith("/")) {
      return false;
    }

    const hasActionVerb =
      /\b(start|restart|stop|run|launch|boot|kill|fix|debug|check|inspect|tail|open|list|show|deploy)\b/.test(text);
    const hasOpsTarget =
      /\b(server|service|daemon|process|port|logs?|local|repo|directory|folder|path|workspace|shell|command|searxng|gateway|worker|npm|pnpm|node|python|docker)\b/.test(
        text
      );

    return hasActionVerb && hasOpsTarget;
  }

  private async proposeLocalOps(
    message: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<LocalOpsProposal | null> {
    if (!this.llmService) {
      return null;
    }

    const allowedRoots = this.capabilityPolicy.shellAllowedDirs.join(", ");
    const prompt = [
      "You are Alfred's local-ops planner.",
      "Convert the user request into a safe shell proposal.",
      "Return strict JSON only with keys:",
      "needsClarification (boolean), question (string), command (string), cwd (string), reason (string), confidence (0..1).",
      "Rules:",
      "- If intent is not clearly a local operation, set needsClarification=true.",
      "- If unsure about command or path, ask a focused question.",
      "- Propose one command only.",
      "- Prefer cwd inside allowed roots.",
      `Allowed roots: ${allowedRoots}`,
      "",
      `User request: ${message.trim()}`
    ].join("\n");

    let raw = "";
    try {
      const result = await this.llmService.generateText(authSessionId, prompt, {
        authPreference,
        executionMode: "reasoning_only"
      });
      raw = result?.text?.trim() ?? "";
    } catch {
      return null;
    }

    if (!raw) {
      return null;
    }

    const parsed = this.tryParseJsonObject(raw);
    if (!parsed) {
      return null;
    }

    const confidenceRaw = Number(parsed.confidence);
    return {
      needsClarification: Boolean(parsed.needsClarification),
      question: typeof parsed.question === "string" ? parsed.question.trim() : undefined,
      command: typeof parsed.command === "string" ? parsed.command.trim() : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd.trim() : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
      confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0
    };
  }

  private tryParseJsonObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      try {
        const parsed = JSON.parse(fencedMatch[1].trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fallback below
      }
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private async routeLongTaskIfNeeded(
    sessionId: string,
    rawText: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<{ jobId: string; response: string; reason: string; taskType: string } | null> {
    if (!this.capabilityPolicy.webSearchEnabled) {
      return null;
    }
    const routed = this.detectLongTaskRoute(rawText);
    if (!routed) {
      return null;
    }

    if (routed.taskType === "web_to_file" && this.requiresApproval("file_write", { sessionId, authSessionId })) {
      const runSpecRunId = randomUUID();
      const runSpec = this.buildWebToFileRunSpec({
        runSpecRunId,
        query: routed.query,
        provider: routed.provider ?? "auto",
        fileFormat: routed.fileFormat ?? "md"
      });
      const approvalResponse = await this.requestNextRunSpecApprovalIfNeeded({
        sessionId,
        runSpecRunId,
        runSpec,
        approvedStepIds: [],
        authSessionId,
        authPreference,
        reason: routed.reason
      });
      if (approvalResponse) {
        return {
          jobId: "",
          taskType: routed.taskType,
          reason: routed.reason,
          response: approvalResponse
        };
      }
    }

    const job = await this.enqueueLongTaskJob(sessionId, {
      taskType: routed.taskType,
      query: routed.query,
      provider: routed.provider,
      authSessionId,
      authPreference,
      reason: routed.reason,
      fileFormat: routed.fileFormat,
      runSpecRunId: routed.taskType === "web_to_file" ? randomUUID() : undefined
    });

    return {
      jobId: job.id,
      taskType: routed.taskType,
      reason: routed.reason,
      response:
        routed.taskType === "web_to_file"
          ? `This looks like a longer research + file delivery task, so I queued it as job ${job.id}. I’ll post progress and send the file when ready.`
          : `This looks like a longer task, so I queued it as job ${job.id}. I’ll post progress updates here.`
    };
  }

  private detectLongTaskRoute(rawText: string): RoutedLongTask | null {
    const text = rawText.trim();
    if (!text) {
      return null;
    }
    if (text.startsWith("/")) {
      return null;
    }

    const lower = text.toLowerCase();
    const explicitResearch =
      lower.includes("web search") ||
      lower.includes("research") ||
      lower.includes("compare") ||
      lower.includes("best ") ||
      lower.includes("top ") ||
      lower.includes("give me options") ||
      lower.includes("one at a time");

    if (!explicitResearch) {
      return null;
    }

    if (text.length < 18) {
      return null;
    }

    const sendAttachment = this.messageWantsAttachment(text);
    const fileFormat = this.detectRequestedAttachmentFormat(text);

    return {
      taskType: sendAttachment ? "web_to_file" : "agentic_turn",
      query: text,
      provider: this.capabilityPolicy.webSearchProvider,
      fileFormat: sendAttachment ? fileFormat : undefined,
      reason: "heuristic_research_route"
    };
  }

  private looksLikeProgressQuery(rawText: string): boolean {
    const normalized = rawText.trim().toLowerCase();
    const compact = normalized.replace(/[!?.,]+$/g, "");
    if (!normalized) {
      return false;
    }
    if (compact === "status" || compact === "progress" || compact === "update") {
      return true;
    }
    return /(?:what(?:'s| is)?\s+the\s+status|how(?:'s| is)\s+it\s+going|any\s+update|job\s+status)/i.test(normalized);
  }

  private messageWantsAttachment(rawText: string): boolean {
    const lower = rawText.toLowerCase();
    const asksSend = /\b(send|share|deliver|attach)\b/.test(lower);
    const asksFile = /\b(file|doc|document|attachment|markdown|txt)\b/.test(lower);
    return asksSend && asksFile;
  }

  private detectRequestedAttachmentFormat(rawText: string): "md" | "txt" | "doc" {
    const lower = rawText.toLowerCase();
    if (/\bmarkdown|\.md\b/.test(lower)) {
      return "md";
    }
    if (/\btxt|text file\b/.test(lower)) {
      return "txt";
    }
    if (/\bdoc|word\b/.test(lower)) {
      return "doc";
    }
    return "md";
  }

  private async findLatestActiveJob(sessionId: string): Promise<Awaited<ReturnType<FileBackedQueueStore["listJobs"]>>[number] | null> {
    const jobs = await this.store.listJobs();
    const relevant = jobs.filter((job) => {
      const owner = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
      return owner === sessionId && (job.status === "queued" || job.status === "running" || job.status === "cancelling");
    });
    if (relevant.length === 0) {
      return null;
    }
    relevant.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return relevant[0] ?? null;
  }

  private async enqueueLongTaskJob(
    sessionId: string,
    input: {
      taskType: "agentic_turn" | "web_search" | "web_to_file";
      query: string;
      provider?: WebSearchProvider;
      authSessionId: string;
      authPreference: LlmAuthPreference;
      reason: string;
      fileFormat?: "md" | "txt" | "doc";
      fileName?: string;
      runSpecRunId?: string;
      runSpecApprovedStepIds?: string[];
    }
  ) {
    if (this.pagedResponseStore) {
      await this.pagedResponseStore.clear(sessionId);
    }

    if (input.taskType === "web_search" || input.taskType === "agentic_turn" || input.taskType === "web_to_file") {
      await this.recordToolUsage(sessionId, "web.search", {
        provider: input.provider ?? this.capabilityPolicy.webSearchProvider,
        route: input.reason,
        taskType: input.taskType,
        query: input.query
      });
    }

    if (input.taskType === "web_to_file") {
      const runSpecRunId = input.runSpecRunId ?? randomUUID();
      const runSpec = this.buildWebToFileRunSpec({
        runSpecRunId,
        query: input.query,
        provider: input.provider ?? "auto",
        fileFormat: input.fileFormat ?? "md",
        fileName: input.fileName,
        sessionId,
        authSessionId: input.authSessionId
      });
      const approvedStepIds = (input.runSpecApprovedStepIds ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
      return this.enqueueRunSpecJob(sessionId, {
        runSpecRunId,
        runSpec,
        approvedStepIds,
        authSessionId: input.authSessionId,
        authPreference: input.authPreference,
        reason: input.reason
      });
    }

    const job = await this.store.createJob({
      type: "stub_task",
      payload: {
        sessionId,
        taskType: input.taskType,
        query: input.query,
        provider: input.provider ?? this.capabilityPolicy.webSearchProvider,
        authSessionId: input.authSessionId,
        authPreference: input.authPreference,
        routeReason: input.reason
      },
      priority: 5
    });
    return job;
  }

  private async enqueueRunSpecJob(
    sessionId: string,
    input: {
      runSpecRunId: string;
      runSpec: RunSpecV1;
      approvedStepIds: string[];
      authSessionId: string;
      authPreference: LlmAuthPreference;
      reason: string;
    }
  ) {
    const approvedStepIds = input.approvedStepIds.map((item) => item.trim()).filter((item) => item.length > 0);
    const job = await this.store.createJob({
      type: "stub_task",
      payload: {
        sessionId,
        taskType: "run_spec",
        runSpec: input.runSpec,
        runSpecRunId: input.runSpecRunId,
        approvedStepIds,
        authSessionId: input.authSessionId,
        authPreference: input.authPreference,
        routeReason: input.reason
      },
      priority: 5
    });
    if (this.runSpecStore) {
      await this.runSpecStore.put({
        runId: input.runSpecRunId,
        sessionId,
        spec: input.runSpec,
        status: "queued",
        approvedStepIds,
        jobId: job.id
      });
    }
    return job;
  }

  private buildWebToFileRunSpec(input: {
    runSpecRunId: string;
    query: string;
    provider: WebSearchProvider;
    fileFormat: "md" | "txt" | "doc";
    fileName?: string;
    sessionId?: string;
    authSessionId?: string;
  }): RunSpecV1 {
    const safeBaseName =
      this.normalizeAttachmentFileName(input.fileName) ??
      this.normalizeAttachmentFileName(input.query.toLowerCase().replace(/[^a-z0-9]+/g, "_")) ??
      `research_${new Date().toISOString().slice(0, 10)}`;
    const fileName = this.ensureAttachmentExtension(safeBaseName, input.fileFormat);
    const requireWriteApproval = this.requiresApproval("file_write", {
      sessionId: input.sessionId,
      authSessionId: input.authSessionId
    });
    const requireSendApproval = requireWriteApproval && this.capabilityPolicy.approvalMode === "strict";
    return {
      version: 1,
      id: input.runSpecRunId,
      goal: `Research and send attachment: ${input.query}`,
      metadata: {
        route: "web_to_file",
        provider: input.provider
      },
      steps: [
        {
          id: "search",
          type: "web.search",
          name: "Web Search",
          input: {
            query: input.query,
            provider: input.provider
          }
        },
        {
          id: "compose",
          type: "doc.compose",
          name: "Compose Document",
          input: {
            query: input.query,
            fileFormat: input.fileFormat
          }
        },
        {
          id: "write",
          type: "file.write",
          name: "Write File",
          input: {
            fileFormat: input.fileFormat,
            fileName
          },
          approval: {
            required: requireWriteApproval,
            capability: "file_write"
          }
        },
        {
          id: "send",
          type: "channel.send_attachment",
          name: "Send Attachment",
          input: {
            caption: `Research doc: ${input.query.slice(0, 80)}`
          },
          approval: {
            required: requireSendApproval,
            capability: "file_write"
          }
        }
      ]
    };
  }

  private ensureAttachmentExtension(fileName: string, format: "md" | "txt" | "doc"): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(`.${format}`)) {
      return fileName;
    }
    return `${fileName}.${format}`;
  }

  private findNextRequiredRunSpecStep(runSpec: RunSpecV1, approvedStepIds: string[]): string | null {
    const approved = new Set(approvedStepIds);
    for (const step of runSpec.steps) {
      if (step.approval?.required === true && !approved.has(step.id)) {
        return step.id;
      }
    }
    return null;
  }

  private async requestNextRunSpecApprovalIfNeeded(input: {
    sessionId: string;
    runSpecRunId: string;
    runSpec: RunSpecV1;
    approvedStepIds: string[];
    authSessionId: string;
    authPreference: LlmAuthPreference;
    reason: string;
  }): Promise<string | null> {
    const approvedStepIds = Array.from(new Set(input.approvedStepIds.map((item) => item.trim()).filter((item) => item.length > 0)));
    let nextStepId = this.findNextRequiredRunSpecStep(input.runSpec, approvedStepIds);
    while (nextStepId) {
      const nextStep = input.runSpec.steps.find((step) => step.id === nextStepId);
      if (!nextStep) {
        break;
      }
      if (nextStep.approval?.capability === "file_write" && this.hasFileWriteApprovalLease(input.sessionId, input.authSessionId)) {
        if (!approvedStepIds.includes(nextStepId)) {
          approvedStepIds.push(nextStepId);
        }
        if (this.runSpecStore) {
          await this.runSpecStore.grantStepApproval(input.runSpecRunId, nextStepId);
        }
        nextStepId = this.findNextRequiredRunSpecStep(input.runSpec, approvedStepIds);
        continue;
      }
      break;
    }
    if (!nextStepId) {
      return null;
    }
    if (!this.approvalStore) {
      return "Approvals are not configured.";
    }

    const nextStep = input.runSpec.steps.find((step) => step.id === nextStepId);
    const approval = await this.approvalStore.create(input.sessionId, "run_spec_step", {
      runSpecRunId: input.runSpecRunId,
      runSpec: input.runSpec,
      approvedStepIds,
      nextStepId,
      authSessionId: input.authSessionId,
      authPreference: input.authPreference,
      reason: input.reason
    });

    if (this.runSpecStore) {
      await this.runSpecStore.put({
        runId: input.runSpecRunId,
        sessionId: input.sessionId,
        spec: input.runSpec,
        status: "awaiting_approval",
        approvedStepIds
      });
      await this.runSpecStore.appendEvent(input.runSpecRunId, {
        type: "approval_requested",
        stepId: nextStepId,
        message: `Approval requested for ${nextStepId}`,
        payload: { token: approval.token }
      });
      await this.runSpecStore.updateStep(input.runSpecRunId, nextStepId, {
        status: "approval_required",
        message: "Awaiting user approval"
      });
    }

    return `Approval required for step '${nextStep?.name ?? nextStepId}'. Reply yes or no. Optional explicit token: approve ${approval.token}`;
  }

  private async executeApprovedAction(
    approval: { action: string; payload: Record<string, unknown> },
    channelSessionId: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<string> {
    if (approval.action === "send_text") {
      const text = String(approval.payload.text ?? "");
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: "Approved send_text action",
        details: text,
        dedupeKey: `approval_execute:${channelSessionId}:send_text:${text.slice(0, 40)}`
      });
      return `Approved action executed: send '${text}'`;
    }
    if (approval.action === "web_search") {
      if (!this.capabilityPolicy.webSearchEnabled) {
        return "Approved action failed: web search is disabled by policy.";
      }
      const query = String(approval.payload.query ?? "").trim();
      const provider = this.normalizeWebSearchProvider(approval.payload.provider);
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      const requestedAuthPreference = this.normalizeAuthPreference(approval.payload.authPreference ?? authPreference);
      if (!query) {
        return "Approved action failed: missing web search query.";
      }
      const job = await this.enqueueLongTaskJob(channelSessionId, {
        taskType: "web_search",
        query,
        provider: provider ?? this.capabilityPolicy.webSearchProvider,
        authSessionId: targetAuthSessionId,
        authPreference: requestedAuthPreference,
        reason: "approved_web_search"
      });
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: `Approved web_search action (${provider ?? this.capabilityPolicy.webSearchProvider})`,
        details: query,
        dedupeKey: `approval_execute:${channelSessionId}:web_search:${query.slice(0, 40)}`
      });
      return `Approved action executed: web_search (queued job ${job.id}).`;
    }
    if (approval.action === "shell_exec_override") {
      const command = String(approval.payload.command ?? "").trim();
      const requestedCwd = typeof approval.payload.cwd === "string" ? approval.payload.cwd.trim() : undefined;
      const blockedRuleId = String(approval.payload.blockedRuleId ?? "unknown_rule");
      if (!command) {
        return "Approved action failed: missing shell command.";
      }
      const resolvedCwd = this.resolveShellCwd(requestedCwd);
      if (!resolvedCwd.ok) {
        return `Approved action failed: ${resolvedCwd.error}`;
      }
      await this.recordToolUsage(channelSessionId, "shell.exec", {
        command,
        cwd: resolvedCwd.cwd,
        override: true,
        blockedRuleId
      });
      const output = await this.executeShellCommand(command, resolvedCwd.cwd);
      return `Approved risky shell override (${blockedRuleId}).\n${output}`;
    }
    if (approval.action === "shell_exec") {
      const command = String(approval.payload.command ?? "").trim();
      const requestedCwd = typeof approval.payload.cwd === "string" ? approval.payload.cwd.trim() : undefined;
      if (!command) {
        return "Approved action failed: missing shell command.";
      }
      const resolvedCwd = this.resolveShellCwd(requestedCwd);
      if (!resolvedCwd.ok) {
        return `Approved action failed: ${resolvedCwd.error}`;
      }
      const shellPolicy = this.evaluateShellCommandPolicy(command);
      if (shellPolicy.blocked) {
        return `Approved action failed: shell command blocked by policy (${shellPolicy.ruleId}).`;
      }
      await this.recordToolUsage(channelSessionId, "shell.exec", {
        command,
        cwd: resolvedCwd.cwd,
        override: false
      });
      const output = await this.executeShellCommand(command, resolvedCwd.cwd);
      return `Approved action executed: shell_exec\n${output}`;
    }
    if (approval.action === "web_to_file_send") {
      if (!this.capabilityPolicy.webSearchEnabled) {
        return "Approved action failed: web search is disabled by policy.";
      }
      if (!this.notificationStore) {
        return "Approved action failed: notification channel is not configured.";
      }
      const query = String(approval.payload.query ?? "").trim();
      const provider = this.normalizeWebSearchProvider(approval.payload.provider);
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      const requestedAuthPreference = this.normalizeAuthPreference(approval.payload.authPreference ?? authPreference);
      const fileFormat = this.normalizeAttachmentFormat(approval.payload.fileFormat) ?? "md";
      const fileName = this.normalizeAttachmentFileName(approval.payload.fileName);
      if (!query) {
        return "Approved action failed: missing research query.";
      }
      const job = await this.enqueueLongTaskJob(channelSessionId, {
        taskType: "web_to_file",
        query,
        provider: provider ?? "auto",
        authSessionId: targetAuthSessionId,
        authPreference: requestedAuthPreference,
        reason: "approved_web_to_file_send",
        fileFormat,
        fileName
      });
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: `Approved web_to_file_send action (${fileFormat})`,
        details: query,
        dedupeKey: `approval_execute:${channelSessionId}:web_to_file_send:${query.slice(0, 40)}`
      });
      return `Approved action executed: web_to_file_send (queued job ${job.id}).`;
    }
    if (approval.action === "run_spec_step") {
      const runSpecParsed = RunSpecV1Schema.safeParse(approval.payload.runSpec);
      if (!runSpecParsed.success) {
        return "Approved action failed: run spec payload is invalid.";
      }
      const runSpec = runSpecParsed.data;
      const runSpecRunId = String(approval.payload.runSpecRunId ?? runSpec.id ?? "").trim();
      if (!runSpecRunId) {
        return "Approved action failed: missing run spec id.";
      }
      const nextStepId = String(approval.payload.nextStepId ?? "").trim();
      if (!nextStepId) {
        return "Approved action failed: missing step id.";
      }
      const payloadApprovedStepIds = Array.isArray(approval.payload.approvedStepIds)
        ? approval.payload.approvedStepIds
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0)
        : [];
      const approvedStepIds = Array.from(new Set([...payloadApprovedStepIds, nextStepId]));
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      const requestedAuthPreference = this.normalizeAuthPreference(approval.payload.authPreference ?? authPreference);
      const reason = String(approval.payload.reason ?? "approved_run_spec_step");
      if (this.runSpecStore) {
        await this.runSpecStore.grantStepApproval(runSpecRunId, nextStepId);
      }
      const approvedStep = runSpec.steps.find((step) => step.id === nextStepId);
      if (approvedStep?.approval?.capability === "file_write") {
        this.grantFileWriteApprovalLease(channelSessionId, targetAuthSessionId);
      }

      const pendingApproval = await this.requestNextRunSpecApprovalIfNeeded({
        sessionId: channelSessionId,
        runSpecRunId,
        runSpec,
        approvedStepIds,
        authSessionId: targetAuthSessionId,
        authPreference: requestedAuthPreference,
        reason
      });
      if (pendingApproval) {
        return `Step '${nextStepId}' approved. ${pendingApproval}`;
      }

      const job = await this.enqueueRunSpecJob(channelSessionId, {
        runSpecRunId,
        runSpec,
        approvedStepIds,
        authSessionId: targetAuthSessionId,
        authPreference: requestedAuthPreference,
        reason
      });
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: `Approved run_spec_step action (${nextStepId})`,
        details: runSpecRunId,
        dedupeKey: `approval_execute:${channelSessionId}:run_spec_step:${runSpecRunId}:${nextStepId}`
      });
      return `Step '${nextStepId}' approved. Run queued as job ${job.id}.`;
    }
    if (approval.action === "file_write") {
      if (!this.capabilityPolicy.fileWriteEnabled) {
        return "Approved action failed: file write is disabled by policy.";
      }
      const relativePath = String(approval.payload.relativePath ?? "").trim();
      const text = String(approval.payload.text ?? "");
      const resolved = this.resolveWorkspacePath(relativePath);
      if (!resolved.ok) {
        return `Approved action failed: ${resolved.error}`;
      }
      const output = await this.executeFileWrite(resolved.absolutePath, text);
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      this.grantFileWriteApprovalLease(channelSessionId, targetAuthSessionId);
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: "Approved file_write action",
        details: relativePath,
        dedupeKey: `approval_execute:${channelSessionId}:file_write:${relativePath}`
      });
      return `Approved action executed: file_write\n${output}`;
    }
    if (approval.action === "file_send") {
      const relativePath = String(approval.payload.relativePath ?? "").trim();
      const caption = typeof approval.payload.caption === "string" ? approval.payload.caption : undefined;
      const resolved = this.resolveWorkspacePath(relativePath);
      if (!resolved.ok) {
        return `Approved action failed: ${resolved.error}`;
      }
      const attachmentPolicy = this.validateAttachmentPath(resolved.absolutePath);
      if (!attachmentPolicy.ok) {
        return `Approved action failed: ${attachmentPolicy.error}`;
      }
      const output = await this.executeFileSend(channelSessionId, resolved.absolutePath, caption);
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      this.grantFileWriteApprovalLease(channelSessionId, targetAuthSessionId);
      await this.recordMemoryCheckpoint(channelSessionId, {
        class: "decision",
        source: "approval_execute",
        summary: "Approved file_send action",
        details: relativePath,
        dedupeKey: `approval_execute:${channelSessionId}:file_send:${relativePath}`
      });
      return `Approved action executed: file_send\n${output}`;
    }

    await this.recordMemoryCheckpoint(channelSessionId, {
      class: "decision",
      source: "approval_execute",
      summary: `Approved action executed: ${approval.action}`,
      dedupeKey: `approval_execute:${channelSessionId}:${approval.action}`
    });
    return `Approved action executed: ${approval.action}`;
  }

  private buildApprovalPayloadPreview(payload: Record<string, unknown>): string {
    if (!payload || typeof payload !== "object") {
      return "";
    }

    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (query) {
      return query.replace(/\s+/g, " ").slice(0, 140);
    }

    const relativePath = typeof payload.relativePath === "string" ? payload.relativePath.trim() : "";
    if (relativePath) {
      return relativePath.slice(0, 140);
    }

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text) {
      return text.replace(/\s+/g, " ").slice(0, 140);
    }

    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (command) {
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      const combined = cwd ? `${command} @ ${cwd}` : command;
      return combined.replace(/\s+/g, " ").slice(0, 140);
    }

    return "";
  }

  private async queueInFlightStatus(sessionId: string, text: string): Promise<void> {
    if (!this.notificationStore) {
      return;
    }
    try {
      await this.notificationStore.enqueue({
        sessionId,
        text,
        status: "running"
      });
    } catch {
      // best-effort progress status only
    }
  }

  private async executeChatTurn(sessionId: string, text: string, authPreference: LlmAuthPreference): Promise<string> {
    const prepared = await this.prepareChatInput(sessionId, text, authPreference);
    if (!this.llmService) {
      return "No model backend is configured. Connect ChatGPT OAuth or set OPENAI_API_KEY.";
    }

    try {
      const result = await this.llmService.generateText(sessionId, prepared.prompt, {
        authPreference,
        executionMode: "reasoning_only"
      });
      const llmText = result?.text?.trim();
      if (!llmText) {
        return this.noModelResponse(authPreference);
      }

      if (prepared.references.length === 0) {
        return llmText;
      }

      return `${llmText}\n\nMemory references:\n${prepared.references
        .map((reference) => `- [${reference.class}] ${reference.source}`)
        .join("\n")}`;
    } catch (error) {
      return this.humanizeLlmError(error);
    }
  }

  private async queueJobNotification(
    sessionId: string,
    jobId: string,
    status: string,
    text: string
  ): Promise<void> {
    if (!this.notificationStore) {
      return;
    }

    await this.notificationStore.enqueue({
      sessionId,
      jobId,
      status,
      text
    });
  }

  private async recordConversation(
    sessionId: string,
    direction: "inbound" | "outbound" | "system",
    text: string,
    options?: {
      source?: "gateway" | "whatsapp" | "auth" | "memory" | "worker" | "system";
      channel?: "direct" | "baileys" | "api" | "internal";
      kind?: "chat" | "command" | "job" | "status" | "error" | "dedupe";
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.conversationStore) {
      return;
    }
    try {
      await this.conversationStore.add(sessionId, direction, text, options);
    } catch {
      // Observability is best-effort; never block user flows.
    }
  }

  private async resolveAuthSessionId(channelSessionId: string, provider: string): Promise<string> {
    if (provider !== "baileys" || !this.identityProfileStore) {
      return channelSessionId;
    }

    try {
      return await this.identityProfileStore.resolveAuthSession(channelSessionId);
    } catch {
      return channelSessionId;
    }
  }

  private normalizeAuthPreference(raw: unknown): LlmAuthPreference {
    if (typeof raw !== "string") {
      return "auto";
    }
    const value = raw.trim().toLowerCase();
    if (value === "oauth") {
      return "oauth";
    }
    if (value === "api_key") {
      return "api_key";
    }
    return "auto";
  }

  private normalizeQueueMode(raw: unknown): RunQueueMode {
    if (typeof raw !== "string") {
      return "steer";
    }
    const value = raw.trim().toLowerCase();
    if (value === "collect") {
      return "collect";
    }
    if (value === "followup") {
      return "followup";
    }
    return "steer";
  }

  private resolveIdempotencyKey(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 128);
  }

  private buildSkillsSnapshot(): { hash: string; content: string[] } {
    const content = [
      "intent_planner",
      "web_search",
      "web_to_file_send",
      "memory_search",
      "calendar",
      "reminders",
      "notes",
      "tasks",
      "approval_gate",
      "file_write_policy",
      "file_send_attachment",
      "sandbox_policy_surface"
    ];
    const hash = content.join("|");
    return { hash, content };
  }

  private normalizeWebSearchProvider(raw: unknown): WebSearchProvider | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const value = raw.trim().toLowerCase();
    if (
      value === "searxng" ||
      value === "openai" ||
      value === "brave" ||
      value === "perplexity" ||
      value === "brightdata" ||
      value === "auto"
    ) {
      return value;
    }
    return undefined;
  }

  private normalizeAttachmentFormat(raw: unknown): "md" | "txt" | "doc" | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const value = raw.trim().toLowerCase();
    if (value === "md" || value === "txt" || value === "doc") {
      return value;
    }
    return undefined;
  }

  private normalizeAttachmentFileName(raw: unknown): string | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
    return normalized || undefined;
  }

  private normalizeShellAllowedDirs(rawDirs: unknown, workspaceDir: string): string[] {
    const defaults = [path.resolve(workspaceDir)];
    if (!Array.isArray(rawDirs)) {
      return defaults;
    }
    const normalized = Array.from(
      new Set(
        rawDirs
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
          .map((entry) => path.resolve(this.expandHomePath(entry)))
      )
    );
    return normalized.length > 0 ? normalized : defaults;
  }

  private expandHomePath(value: string): string {
    if (value === "~") {
      return process.env.HOME ? path.resolve(process.env.HOME) : value;
    }
    if (value.startsWith("~/")) {
      const home = process.env.HOME;
      if (home) {
        return path.join(home, value.slice(2));
      }
    }
    return value;
  }

  private noModelResponse(authPreference: LlmAuthPreference): string {
    if (authPreference === "oauth") {
      return "No OAuth-backed model session is available. Connect ChatGPT OAuth and try again.";
    }
    if (authPreference === "api_key") {
      return "API-key model mode is selected but OPENAI_API_KEY is not configured or unavailable.";
    }
    return "No model response is available. Connect ChatGPT OAuth or configure OPENAI_API_KEY.";
  }

  private humanizeLlmError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const lower = detail.toLowerCase();

    if (lower.includes("timeout")) {
      return "Model request timed out. Please retry.";
    }
    if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("forbidden")) {
      return "Model authentication failed. Reconnect ChatGPT OAuth or verify OPENAI_API_KEY.";
    }
    if (lower.includes("429") || lower.includes("rate")) {
      return "Model rate limit reached. Please wait and retry.";
    }

    return `Model request failed: ${detail}`;
  }

  private async prepareChatInput(
    sessionId: string,
    input: string,
    authPreference: LlmAuthPreference
  ): Promise<{ prompt: string; references: MemoryReference[] }> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { prompt: input, references: [] };
    }

    const providerManagedContext = await this.shouldUseProviderManagedContext(authPreference);
    const historyLines = providerManagedContext ? [] : await this.buildRecentConversationContext(sessionId, trimmed);

    if (!this.memoryService) {
      if (historyLines.length === 0) {
        return { prompt: input, references: [] };
      }
      const promptWithoutMemory = [
        "You are answering using recent persisted conversation context when relevant.",
        "Recent conversation context (oldest first):",
        historyLines.join("\n"),
        `User message: ${trimmed}`
      ].join("\n\n");
      return { prompt: promptWithoutMemory, references: [] };
    }

    let results: MemoryResult[] = [];
    try {
      results = await this.memoryService.searchMemory(trimmed, {
        maxResults: 3,
        minScore: 0.05
      });
    } catch {
      return { prompt: input, references: [] };
    }

    if (results.length === 0 && historyLines.length === 0) {
      return { prompt: input, references: [] };
    }

    const requestedClasses = this.detectRequestedMemoryClasses(trimmed);
    const classifiedResults = results.map((item) => ({
      item,
      class: this.classifyMemoryResult(item)
    }));
    const filteredResults =
      requestedClasses.length === 0
        ? classifiedResults
        : classifiedResults.filter((entry) => requestedClasses.includes(entry.class));
    const selectedResults =
      filteredResults.length > 0 ? filteredResults : requestedClasses.length === 0 ? classifiedResults : [];

    const promptParts = [
      "You are answering with optional memory context.",
      "This is a reasoning-only turn. Do not execute commands, modify files, send messages, or claim side effects were performed.",
      "If the user asks for side effects, propose a concrete next action and ask for explicit approval.",
      "If memory snippets are relevant, use them and cite source as [path:start:end]."
    ];
    if (historyLines.length > 0) {
      promptParts.push("Recent conversation context (oldest first):");
      promptParts.push(historyLines.join("\n"));
    }
    if (selectedResults.length > 0) {
      const snippets = selectedResults.map((entry, index) => {
        const normalizedSnippet = entry.item.snippet.replace(/\s+/g, " ").trim().slice(0, 320);
        return `[${index + 1}] [${entry.class}] ${entry.item.source}\n${normalizedSnippet}`;
      });
      if (requestedClasses.length > 0) {
        promptParts.push(`Requested memory classes: ${requestedClasses.join(", ")}`);
      }
      promptParts.push("Memory snippets:");
      promptParts.push(snippets.join("\n\n"));
    }
    promptParts.push(`User message: ${trimmed}`);

    const prompt = promptParts.join("\n\n");

    return {
      prompt,
      references: selectedResults.map((entry) => ({
        source: entry.item.source,
        class: entry.class
      }))
    };
  }

  private detectRequestedMemoryClasses(query: string): MemoryCheckpointClass[] {
    const lower = query.toLowerCase();
    const classes = new Set<MemoryCheckpointClass>();
    if (/\b(decide|decision|agreed|agree|approved|approval)\b/.test(lower)) {
      classes.add("decision");
    }
    if (/\b(prefer|prefers|preference|like|usually|style)\b/.test(lower)) {
      classes.add("preference");
    }
    if (/\b(todo|task|reminder|pending|follow[- ]?up)\b/.test(lower)) {
      classes.add("todo");
    }
    if (/\b(fact|remember|what is|when|where|who)\b/.test(lower)) {
      classes.add("fact");
    }
    return [...classes];
  }

  private classifyMemoryResult(result: MemoryResult): MemoryCheckpointClass {
    const combined = `${result.path}\n${result.snippet}`.toLowerCase();
    const explicit = combined.match(/class:\s*(decision|todo|preference|fact)/);
    if (explicit?.[1] === "decision" || explicit?.[1] === "todo" || explicit?.[1] === "preference" || explicit?.[1] === "fact") {
      return explicit[1];
    }
    if (/\b(decide|decision|approved|rejected|policy)\b/.test(combined)) {
      return "decision";
    }
    if (/\b(todo|task|reminder|pending)\b/.test(combined)) {
      return "todo";
    }
    if (/\b(prefer|prefers|preference|likes|style)\b/.test(combined)) {
      return "preference";
    }
    return "fact";
  }

  private async buildRecentConversationContext(sessionId: string, currentInput: string): Promise<string[]> {
    if (!this.conversationStore) {
      return [];
    }

    let events: Awaited<ReturnType<ConversationStore["listBySession"]>> = [];
    try {
      events = await this.conversationStore.listBySession(sessionId, 40);
    } catch {
      return [];
    }

    if (events.length === 0) {
      return [];
    }

    const normalizedCurrent = currentInput.replace(/\s+/g, " ").trim().toLowerCase();
    let currentInboundSkipped = false;
    const reversed = [...events].reverse();
    const selected: string[] = [];

    for (const event of reversed) {
      if (event.kind !== "chat" && event.kind !== "command") {
        continue;
      }
      if (event.direction !== "inbound" && event.direction !== "outbound") {
        continue;
      }

      const normalizedText = event.text.replace(/\s+/g, " ").trim();
      if (!normalizedText) {
        continue;
      }

      if (!currentInboundSkipped && event.direction === "inbound" && normalizedText.toLowerCase() === normalizedCurrent) {
        currentInboundSkipped = true;
        continue;
      }

      const role = event.direction === "inbound" ? "user" : "assistant";
      selected.push(`${role}: ${normalizedText.slice(0, 280)}`);
      if (selected.length >= 10) {
        break;
      }
    }

    return selected.reverse();
  }

  private async recordMemoryCheckpoint(
    sessionId: string,
    checkpoint: {
      class: MemoryCheckpointClass;
      source: string;
      summary: string;
      details?: string;
      dedupeKey?: string;
    }
  ): Promise<void> {
    if (!this.memoryCheckpointService) {
      return;
    }
    try {
      await this.memoryCheckpointService.checkpoint({
        sessionId,
        class: checkpoint.class,
        source: checkpoint.source,
        summary: checkpoint.summary,
        details: checkpoint.details,
        dedupeKey: checkpoint.dedupeKey
      });
    } catch {
      // best-effort checkpointing; never block runtime turns
    }
  }

  private requiresApproval(
    capability: ExternalCapability,
    context?: {
      sessionId?: string;
      authSessionId?: string;
    }
  ): boolean {
    const decision = this.evaluateCapabilityPolicy(capability, context);
    return decision.allowed && decision.requiresApproval;
  }

  private evaluateCapabilityPolicy(
    capability: ExternalCapability,
    context?: {
      sessionId?: string;
      authSessionId?: string;
    }
  ) {
    const toolId: ToolId =
      capability === "web_search" ? "web.search" : capability === "file_write" ? "file.write" : capability === "shell_exec" ? "shell.exec" : "wasm.exec";
    return this.evaluateToolPolicy(toolId, context);
  }

  private evaluateToolPolicy(
    toolId: ToolId,
    context?: {
      sessionId?: string;
      authSessionId?: string;
    }
  ) {
    const sessionId = context?.sessionId ?? "";
    const authSessionId = context?.authSessionId ?? "";
    return evaluateToolPolicy(toolId, this.buildToolPolicyInput(), {
      hasFileWriteLease: sessionId ? this.hasFileWriteApprovalLease(sessionId, authSessionId) : false
    });
  }

  private buildToolPolicyInput(): ToolPolicyInput {
    return {
      approvalMode: this.capabilityPolicy.approvalMode,
      approvalDefault: this.capabilityPolicy.approvalDefault,
      webSearchEnabled: this.capabilityPolicy.webSearchEnabled,
      webSearchRequireApproval: this.capabilityPolicy.webSearchRequireApproval,
      fileWriteEnabled: this.capabilityPolicy.fileWriteEnabled,
      fileWriteRequireApproval: this.capabilityPolicy.fileWriteRequireApproval,
      fileWriteApprovalMode: this.capabilityPolicy.fileWriteApprovalMode,
      shellEnabled: this.capabilityPolicy.shellEnabled,
      wasmEnabled: this.capabilityPolicy.wasmEnabled
    };
  }

  private resolveFileWriteApprovalLeaseKey(channelSessionId: string, authSessionId: string): string {
    const channel = channelSessionId.trim() || "unknown";
    const auth = authSessionId.trim();
    if (this.capabilityPolicy.fileWriteApprovalScope === "channel") {
      return `channel:${channel}`;
    }
    return `auth:${auth || channel}`;
  }

  private hasFileWriteApprovalLease(channelSessionId: string, authSessionId: string): boolean {
    if (this.capabilityPolicy.fileWriteApprovalMode !== "session") {
      return false;
    }
    const key = this.resolveFileWriteApprovalLeaseKey(channelSessionId, authSessionId);
    return this.fileWriteApprovalLeases.has(key);
  }

  private grantFileWriteApprovalLease(channelSessionId: string, authSessionId: string): void {
    if (this.capabilityPolicy.fileWriteApprovalMode !== "session") {
      return;
    }
    const key = this.resolveFileWriteApprovalLeaseKey(channelSessionId, authSessionId);
    this.fileWriteApprovalLeases.add(key);
  }

  private async recordToolUsage(
    sessionId: string,
    toolName: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const typedSpec = (TOOL_SPECS_V1 as Record<string, (typeof TOOL_SPECS_V1)[keyof typeof TOOL_SPECS_V1]>)[toolName];
    const provider = typeof payload.provider === "string" ? payload.provider : undefined;
    const route = typeof payload.route === "string" ? payload.route : undefined;
    const query = typeof payload.query === "string" ? payload.query : undefined;
    const shortQuery = query ? query.slice(0, 140) : undefined;
    const parts = [
      `Tool used: ${toolName}`,
      typedSpec ? `tier=${typedSpec.safetyTier}` : "",
      provider ? `provider=${provider}` : "",
      route ? `route=${route}` : "",
      shortQuery ? `query=${shortQuery}` : ""
    ]
      .filter((part) => part.length > 0)
      .join(" | ");
    await this.recordConversation(sessionId, "system", parts, {
      source: "gateway",
      channel: "internal",
      kind: "command",
      metadata: {
        toolUsage: true,
        toolName,
        ...(typedSpec
          ? {
              toolSpecVersion: typedSpec.version,
              toolCapability: typedSpec.capability,
              toolSafetyTier: typedSpec.safetyTier
            }
          : {}),
        ...payload
      }
    });
  }

  private buildSandboxPolicyConfig(): { shellEnabled: boolean; wasmEnabled: boolean } {
    return {
      shellEnabled: this.capabilityPolicy.shellEnabled,
      wasmEnabled: this.capabilityPolicy.wasmEnabled
    };
  }

  private evaluateShellCommandPolicy(command: string): { blocked: false } | { blocked: true; ruleId: string } {
    if (/(^|\s|[;&|])(cd|pushd)\s+/i.test(command)) {
      return { blocked: true, ruleId: "manual_dir_change_use_cwd" };
    }
    return evaluateSandboxShellCommandPolicy(command);
  }

  private resolveWorkspacePath(relativePath: string): { ok: true; absolutePath: string } | { ok: false; error: string } {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      return { ok: false, error: "Missing file path. Usage: /write notes/file.md your text" };
    }
    if (path.isAbsolute(trimmed)) {
      return { ok: false, error: "Absolute paths are not allowed for /write." };
    }
    if (trimmed.split(/[\\/]/).includes("..")) {
      return { ok: false, error: "Path traversal is not allowed for /write." };
    }

    const absolutePath = path.resolve(this.capabilityPolicy.workspaceDir, trimmed);
    const workspace = this.capabilityPolicy.workspaceDir;
    if (!(absolutePath === workspace || absolutePath.startsWith(`${workspace}${path.sep}`))) {
      return { ok: false, error: "Path escapes workspace policy boundary." };
    }

    if (this.capabilityPolicy.fileWriteNotesOnly) {
      const normalizedRelative = path.relative(workspace, absolutePath).replace(/\\/g, "/");
      const notesRoot = this.capabilityPolicy.fileWriteNotesDir.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!(normalizedRelative === notesRoot || normalizedRelative.startsWith(`${notesRoot}/`))) {
        return {
          ok: false,
          error: `File write is restricted to '${notesRoot}/' by policy.`
        };
      }
    }

    return { ok: true, absolutePath };
  }

  private validateAttachmentPath(absolutePath: string): { ok: true } | { ok: false; error: string } {
    const ext = path.extname(absolutePath).toLowerCase();
    const allowed = new Set([".md", ".txt", ".doc"]);
    if (!allowed.has(ext)) {
      return { ok: false, error: "Only .md, .txt, and .doc files can be sent as attachments." };
    }
    return { ok: true };
  }

  private resolveAttachmentMimeType(absolutePath: string): string {
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext === ".md") {
      return "text/markdown";
    }
    if (ext === ".txt") {
      return "text/plain";
    }
    if (ext === ".doc") {
      return "application/msword";
    }
    return "application/octet-stream";
  }

  private async executeFileWrite(absolutePath: string, text: string): Promise<string> {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const content = text.endsWith("\n") ? text : `${text}\n`;
    await fs.appendFile(absolutePath, content, "utf8");

    const relativePath = path.relative(this.capabilityPolicy.workspaceDir, absolutePath).replace(/\\/g, "/");
    return `Appended ${content.length} chars to workspace/${relativePath}`;
  }

  private async executeFileSend(sessionId: string, absolutePath: string, caption?: string): Promise<string> {
    if (!this.notificationStore) {
      return "File send is unavailable: notification channel is not configured.";
    }

    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      return `File not found in workspace: ${path.relative(this.capabilityPolicy.workspaceDir, absolutePath).replace(/\\/g, "/")}`;
    }

    const maxBytes = 5 * 1024 * 1024;
    if (stats.size > maxBytes) {
      return `File is too large (${stats.size} bytes). Max supported attachment size is ${maxBytes} bytes.`;
    }

    const fileName = path.basename(absolutePath);
    await this.notificationStore.enqueue({
      kind: "file",
      sessionId,
      filePath: absolutePath,
      fileName,
      mimeType: this.resolveAttachmentMimeType(absolutePath),
      caption
    });

    const relativePath = path.relative(this.capabilityPolicy.workspaceDir, absolutePath).replace(/\\/g, "/");
    return `Queued attachment send: workspace/${relativePath}`;
  }

  private resolveShellCwd(rawCwd?: string): { ok: true; cwd: string } | { ok: false; error: string } {
    const requested = typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : this.capabilityPolicy.workspaceDir;
    const expanded = this.expandHomePath(requested);
    const candidateRaw = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.capabilityPolicy.workspaceDir, expanded);
    const candidate = this.canonicalizePathForScope(candidateRaw);
    const allowed = this.capabilityPolicy.shellAllowedDirs.some((root) => this.isPathInsideRoot(candidate, root));
    if (!allowed) {
      return {
        ok: false,
        error: `Shell cwd is outside allowed scope: ${candidate}. Allowed roots: ${this.capabilityPolicy.shellAllowedDirs.join(", ")}`
      };
    }
    return { ok: true, cwd: candidate };
  }

  private isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    const normalizedRoot = this.canonicalizePathForScope(rootPath);
    const normalizedTarget = this.canonicalizePathForScope(targetPath);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  }

  private canonicalizePathForScope(rawPath: string): string {
    const sanitized = this.stripInvisiblePathChars(String(rawPath ?? ""));
    const resolved = path.resolve(sanitized);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  private stripInvisiblePathChars(rawPath: string): string {
    // Remove common hidden code points that frequently appear in copied paths.
    return rawPath.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
  }

  private async executeShellCommand(command: string, cwdOverride?: string): Promise<string> {
    const trimmed = command.trim();
    if (!trimmed) {
      return "Shell command is empty.";
    }

    const maxOutputChars = this.capabilityPolicy.shellMaxOutputChars;
    const timeoutMs = this.capabilityPolicy.shellTimeoutMs;
    const cwd = cwdOverride ?? this.capabilityPolicy.workspaceDir;

    return await new Promise((resolve) => {
      const child = spawn(trimmed, {
        cwd,
        shell: true,
        env: process.env
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const appendBounded = (current: string, chunk: string) => {
        if (!chunk) {
          return current;
        }
        const combined = `${current}${chunk}`;
        if (combined.length <= maxOutputChars) {
          return combined;
        }
        return combined.slice(0, maxOutputChars);
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = appendBounded(stdout, String(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, String(chunk));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(`Shell failed to start: ${error.message}`);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const lines = [`Shell run in workspace (${path.relative(process.cwd(), cwd) || "."})`];
        if (timedOut) {
          lines.push(`Result: timed_out_after_${timeoutMs}ms`);
        } else {
          lines.push(`Result: exit_code=${String(code ?? "null")}${signal ? ` signal=${signal}` : ""}`);
        }
        if (stdout.trim()) {
          lines.push("", "stdout:", stdout.trimEnd());
        }
        if (stderr.trim()) {
          lines.push("", "stderr:", stderr.trimEnd());
        }
        resolve(lines.join("\n"));
      });
    });
  }

  private async executeWebSearch(
    authSessionId: string,
    query: string,
    authPreference: LlmAuthPreference = "auto",
    provider: WebSearchProvider = this.capabilityPolicy.webSearchProvider
  ): Promise<string> {
    if (this.webSearchService) {
      try {
        const result = await this.webSearchService.search(query, {
          provider,
          authSessionId,
          authPreference
        });
        if (result?.text?.trim()) {
          return `Web search provider: ${result.provider}\n${result.text.trim()}`;
        }
      } catch (error) {
        return this.humanizeLlmError(error);
      }
    }

    if (!this.llmService) {
      return "No web search provider is currently available. Configure OpenAI/Codex, Brave, or Perplexity.";
    }

    try {
      const prompt = [
        "You are a web research assistant.",
        "Use available web-search/browsing tools if available.",
        "Return concise findings with source links and publication dates when possible.",
        `Query: ${query.trim()}`
      ].join("\n");
      const result = await this.llmService.generateText(authSessionId, prompt, { authPreference });
      const text = result?.text?.trim();
      if (!text) {
        return "No web search result is available for this query.";
      }
      return `Web search provider: openai\n${text}`;
    } catch (error) {
      return this.humanizeLlmError(error);
    }
  }

  private async shouldUseProviderManagedContext(authPreference: LlmAuthPreference): Promise<boolean> {
    if (authPreference === "api_key") {
      return false;
    }

    if (!this.codexAuthService) {
      return false;
    }

    try {
      const status = await this.codexAuthService.readStatus(false);
      return status.connected === true && status.authMode === "chatgpt";
    } catch {
      return false;
    }
  }
}
