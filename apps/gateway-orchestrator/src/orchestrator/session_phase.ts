import type {
  LlmAuthPreference,
  NormalizedInboundContext,
  OrchestrationPhase,
  RunStartResult,
  SessionPhaseContext,
  ToolPolicySnapshot
} from "./types";
import type { RunQueueMode } from "../builtins/run_ledger_store";

type RunLedger = {
  startRun: (input: {
    sessionKey: string;
    queueMode?: RunQueueMode;
    idempotencyKey?: string;
    model?: string;
    provider?: string;
    toolPolicySnapshot?: Record<string, unknown>;
    skillsSnapshot?: { hash?: string; content?: string[] };
  }) => Promise<RunStartResult>;
  transitionPhase: (
    runId: string,
    phase: OrchestrationPhase,
    message?: string,
    payload?: Record<string, unknown>
  ) => Promise<unknown>;
  appendEvent: (
    runId: string,
    type: "note" | "queued" | "progress" | "tool_event" | "partial",
    phase?: OrchestrationPhase,
    message?: string,
    payload?: Record<string, unknown>
  ) => Promise<unknown>;
  completeRun: (runId: string, status: "completed" | "failed" | "cancelled", message?: string) => Promise<unknown>;
};

export async function runSessionPhase(input: {
  normalized: NormalizedInboundContext;
  resolveAuthSessionId: (sessionId: string, provider: string) => Promise<string>;
  normalizeAuthPreference: (raw: unknown) => LlmAuthPreference;
  normalizeQueueMode: (raw: unknown) => RunQueueMode;
  resolveIdempotencyKey: (raw: unknown) => string | undefined;
  runLedger?: RunLedger;
  codexApiKey?: string;
  capabilityPolicySnapshot: ToolPolicySnapshot;
  buildSkillsSnapshot: () => { hash?: string; content?: string[] };
}): Promise<SessionPhaseContext> {
  const { normalized } = input;
  const authSessionId = await input.resolveAuthSessionId(normalized.inbound.sessionId, normalized.provider);
  const authPreference = input.normalizeAuthPreference(normalized.inbound.metadata?.authPreference);
  const queueMode = input.normalizeQueueMode(normalized.inbound.metadata?.queueMode);
  const idempotencyKey = input.resolveIdempotencyKey(normalized.inbound.metadata?.idempotencyKey);

  const runStart = await input.runLedger?.startRun({
    sessionKey: authSessionId,
    queueMode,
    idempotencyKey,
    model: authPreference === "oauth" ? "openai-codex/default" : input.codexApiKey ? "openai/default" : "none",
    provider: authPreference === "oauth" ? "openai-codex" : "openai",
    toolPolicySnapshot: input.capabilityPolicySnapshot,
    skillsSnapshot: input.buildSkillsSnapshot()
  });
  const runId = runStart?.run.runId;

  const markPhase = async (
    phase: OrchestrationPhase,
    message?: string,
    details?: Record<string, unknown>
  ): Promise<void> => {
    if (!runId || !input.runLedger) {
      return;
    }
    try {
      await input.runLedger.transitionPhase(runId, phase, message, details);
    } catch {
      // best-effort observability
    }
  };

  const markRunNote = async (message: string, details?: Record<string, unknown>): Promise<void> => {
    if (!runId || !input.runLedger) {
      return;
    }
    try {
      await input.runLedger.appendEvent(runId, "note", undefined, message, details);
    } catch {
      // best-effort observability
    }
  };

  const completeRun = async (failureMessage?: string | null): Promise<void> => {
    if (!runId || !input.runLedger) {
      return;
    }
    await markPhase("dispatch", failureMessage ? "Dispatch ended with failure" : "Dispatch completed");
    await input.runLedger.completeRun(runId, failureMessage ? "failed" : "completed", failureMessage ?? undefined);
  };

  return {
    authSessionId,
    authPreference,
    queueMode,
    idempotencyKey,
    runStart,
    runId,
    markPhase,
    markRunNote,
    completeRun
  };
}

