import type { InboundMessage } from "../../../../packages/contracts/src";
import type { RunQueueMode } from "../builtins/run_ledger_store";
import type { WebSearchProvider } from "../builtins/web_search_service";

export type LlmAuthPreference = "auto" | "oauth" | "api_key";

export type OrchestrationPhase =
  | "normalize"
  | "session"
  | "directives"
  | "plan"
  | "policy"
  | "route"
  | "persist"
  | "dispatch";

export type NormalizedInboundContext = {
  inbound: InboundMessage;
  provider: string;
  source: "whatsapp" | "gateway";
  channel: "baileys" | "direct";
};

export type OrchestrationMarkers = {
  markPhase: (phase: OrchestrationPhase, message?: string, details?: Record<string, unknown>) => Promise<void>;
  markRunNote: (message: string, details?: Record<string, unknown>) => Promise<void>;
};

export type RunStartResult = {
  acquired: boolean;
  run: { runId: string };
  activeRunId?: string;
};

export type SessionPhaseContext = OrchestrationMarkers & {
  authSessionId: string;
  authPreference: LlmAuthPreference;
  queueMode: RunQueueMode;
  idempotencyKey?: string;
  runStart?: RunStartResult;
  runId?: string;
  completeRun: (failureMessage?: string | null) => Promise<void>;
};

export type ToolPolicySnapshot = {
  approvalMode: "strict" | "balanced" | "relaxed";
  approvalDefault: boolean;
  webSearchEnabled: boolean;
  webSearchRequireApproval: boolean;
  webSearchProvider: string;
  fileWriteEnabled: boolean;
  fileWriteRequireApproval: boolean;
  fileWriteNotesOnly: boolean;
  fileWriteNotesDir: string;
  fileWriteApprovalMode: "per_action" | "session" | "always";
  fileWriteApprovalScope: "auth" | "channel";
  shellEnabled: boolean;
  wasmEnabled: boolean;
};

export type PlannerDecision = {
  intent: "chat" | "web_research" | "status_query" | "clarify" | "command";
  confidence: number;
  needsWorker: boolean;
  query?: string;
  question?: string;
  provider?: WebSearchProvider;
  sendAttachment?: boolean;
  fileFormat?: "md" | "txt" | "doc";
  fileName?: string;
  reason: string;
};
