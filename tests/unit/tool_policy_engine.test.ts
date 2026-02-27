import { describe, expect, it } from "vitest";
import { TOOL_SPECS_V1, evaluateToolPolicy } from "../../apps/gateway-orchestrator/src/orchestrator/tool_policy_engine";

const BASE_POLICY = {
  approvalMode: "balanced" as const,
  approvalDefault: true,
  webSearchEnabled: true,
  webSearchRequireApproval: true,
  fileWriteEnabled: true,
  fileWriteRequireApproval: true,
  fileWriteApprovalMode: "session" as const,
  shellEnabled: true
};

describe("tool_policy_engine", () => {
  it("exposes ToolSpec v1 metadata with safety tiers", () => {
    expect(TOOL_SPECS_V1["web.search"].version).toBe(1);
    expect(TOOL_SPECS_V1["web.search"].safetyTier).toBe("read_only");
    expect(TOOL_SPECS_V1["file.write"].safetyTier).toBe("side_effecting");
    expect(TOOL_SPECS_V1["shell.exec"].safetyTier).toBe("privileged");
  });

  it("allows web search without approval when enabled", () => {
    const decision = evaluateToolPolicy("web.search", BASE_POLICY);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires file-write approval when no lease exists in session mode", () => {
    const decision = evaluateToolPolicy("file.write", BASE_POLICY, { hasFileWriteLease: false });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  it("skips file-write approval when lease exists in session mode", () => {
    const decision = evaluateToolPolicy("file.write", BASE_POLICY, { hasFileWriteLease: true });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("blocks shell when shell capability is disabled", () => {
    const decision = evaluateToolPolicy("shell.exec", {
      ...BASE_POLICY,
      shellEnabled: false
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("disabled");
  });
});
