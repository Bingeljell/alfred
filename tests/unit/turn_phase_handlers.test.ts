import { describe, expect, it, vi } from "vitest";
import {
  runDirectivesPhase,
  runDispatchPhase,
  runPersistPhase,
  runPlanPhase,
  runPolicyPhase,
  runRoutePhase
} from "../../apps/gateway-orchestrator/src/orchestrator/turn_phase_handlers";

describe("turn_phase_handlers", () => {
  it("marks the expected phase and executes the handler", async () => {
    const markPhase = vi.fn(async () => undefined);
    const output = await runDirectivesPhase(
      { markPhase },
      "Resolve directives",
      { source: "test" },
      async () => "ok"
    );

    expect(output).toBe("ok");
    expect(markPhase).toHaveBeenCalledWith("directives", "Resolve directives", { source: "test" });
  });

  it("supports plan/policy/route/persist/dispatch wrappers", async () => {
    const markPhase = vi.fn(async () => undefined);

    await runPlanPhase({ markPhase }, "Plan");
    await runPolicyPhase({ markPhase }, "Policy");
    await runRoutePhase({ markPhase }, "Route");
    await runPersistPhase({ markPhase }, "Persist");
    await runDispatchPhase({ markPhase }, "Dispatch");

    expect(markPhase).toHaveBeenNthCalledWith(1, "plan", "Plan", undefined);
    expect(markPhase).toHaveBeenNthCalledWith(2, "policy", "Policy", undefined);
    expect(markPhase).toHaveBeenNthCalledWith(3, "route", "Route", undefined);
    expect(markPhase).toHaveBeenNthCalledWith(4, "persist", "Persist", undefined);
    expect(markPhase).toHaveBeenNthCalledWith(5, "dispatch", "Dispatch", undefined);
  });
});
