import type { OrchestrationPhase } from "./types";

type PhaseMarker = (
  phase: OrchestrationPhase,
  message?: string,
  details?: Record<string, unknown>
) => Promise<void>;

type TurnPhaseContext = {
  markPhase: PhaseMarker;
};

async function runPhase<T>(
  context: TurnPhaseContext,
  phase: OrchestrationPhase,
  message: string,
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  await context.markPhase(phase, message, details);
  if (!handler) {
    return undefined;
  }
  return handler();
}

export async function runDirectivesPhase<T>(
  context: TurnPhaseContext,
  message = "Resolving directives and command surface",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "directives", message, details, handler);
}

export async function runPlanPhase<T>(
  context: TurnPhaseContext,
  message = "Planning intent",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "plan", message, details, handler);
}

export async function runPolicyPhase<T>(
  context: TurnPhaseContext,
  message = "Evaluating policy and approvals",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "policy", message, details, handler);
}

export async function runRoutePhase<T>(
  context: TurnPhaseContext,
  message = "Routing action",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "route", message, details, handler);
}

export async function runPersistPhase<T>(
  context: TurnPhaseContext,
  message = "Persisting response",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "persist", message, details, handler);
}

export async function runDispatchPhase<T>(
  context: TurnPhaseContext,
  message = "Dispatching response",
  details?: Record<string, unknown>,
  handler?: () => Promise<T>
): Promise<T | undefined> {
  return runPhase(context, "dispatch", message, details, handler);
}
