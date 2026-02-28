import type { MemoryService } from "../../../packages/memory/src";
import type { CodexLoginStartMode } from "./codex/auth_service";
import type { OAuthService } from "./auth/oauth_service";
import type { CodexAuthService } from "./codex/auth_service";
import type { ConversationStore } from "./builtins/conversation_store";
import type { IdentityProfileStore } from "./auth/identity_profile_store";
import type { MessageDedupeStore } from "./whatsapp/dedupe_store";
import type { OutboundNotificationStore } from "./notification_store";
import type { ReminderStore } from "./builtins/reminder_store";
import type { NoteStore } from "./builtins/note_store";
import type { TaskStore } from "./builtins/task_store";
import type { ApprovalStore } from "./builtins/approval_store";
import type { RunLedgerStore } from "./builtins/run_ledger_store";
import type { SupervisorStore } from "./builtins/supervisor_store";
import type { RunSpecStore } from "./builtins/run_spec_store";
import type { MemoryCheckpointClass } from "./builtins/memory_checkpoint_service";
import type { LlmAuthPreference, PlannerDecision } from "./orchestrator/types";

export type CreateGatewayAppOptions = {
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
    fileWriteApprovalMode?: "per_action" | "session" | "always";
    fileWriteApprovalScope?: "auth" | "channel";
    shellEnabled?: boolean;
    shellTimeoutMs?: number;
    shellMaxOutputChars?: number;
    wasmEnabled?: boolean;
  };
  baileysInboundToken?: string;
};
