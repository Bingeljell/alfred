import { describe, expect, it } from "vitest";
import { TOOL_SPECS_V1, evaluateToolPolicy } from "../../apps/gateway-orchestrator/src/orchestrator/tool_policy_engine";

const BASE_POLICY = {
  approvalMode: "balanced" as const,
  approvalDefault: true,
  webSearchEnabled: true,
  webSearchRequireApproval: true,
  fileReadEnabled: true,
  fileWriteEnabled: true,
  fileWriteRequireApproval: true,
  fileWriteApprovalMode: "session" as const,
  fileEditEnabled: true,
  fileEditRequireApproval: true,
  shellEnabled: true,
  wasmEnabled: false
};

describe("tool_policy_engine", () => {
  it("exposes ToolSpec v1 metadata with safety tiers", () => {
    expect(TOOL_SPECS_V1["web.search"].version).toBe(1);
    expect(TOOL_SPECS_V1["web.search"].safetyTier).toBe("read_only");
    expect(TOOL_SPECS_V1["file.write"].safetyTier).toBe("side_effecting");
    expect(TOOL_SPECS_V1["shell.exec"].safetyTier).toBe("privileged");
    expect(TOOL_SPECS_V1["process.list"].safetyTier).toBe("read_only");
    expect(TOOL_SPECS_V1["process.kill"].safetyTier).toBe("privileged");
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

  it("allows file-read without approval when enabled", () => {
    const decision = evaluateToolPolicy("file.read", BASE_POLICY);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires file-edit approval when configured", () => {
    const decision = evaluateToolPolicy("file.edit", BASE_POLICY, { hasFileWriteLease: false });
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

  it("blocks process tools when shell capability is disabled", () => {
    const listDecision = evaluateToolPolicy("process.list", {
      ...BASE_POLICY,
      shellEnabled: false
    });
    const killDecision = evaluateToolPolicy("process.kill", {
      ...BASE_POLICY,
      shellEnabled: false
    });
    expect(listDecision.allowed).toBe(false);
    expect(killDecision.allowed).toBe(false);
  });

  it("gates wasm execution by explicit policy flag", () => {
    const disabled = evaluateToolPolicy("wasm.exec", BASE_POLICY);
    expect(disabled.allowed).toBe(false);
    const enabled = evaluateToolPolicy("wasm.exec", {
      ...BASE_POLICY,
      wasmEnabled: true
    });
    expect(enabled.allowed).toBe(true);
  });
});
