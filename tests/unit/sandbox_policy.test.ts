import { describe, expect, it } from "vitest";
import {
  evaluateShellCommandPolicy,
  isSandboxTargetEnabled
} from "../../apps/gateway-orchestrator/src/orchestrator/sandbox_policy";

describe("sandbox_policy", () => {
  it("enables or disables shell/wasm targets from one config surface", () => {
    expect(isSandboxTargetEnabled("shell.exec", { shellEnabled: true, wasmEnabled: false })).toBe(true);
    expect(isSandboxTargetEnabled("wasm.exec", { shellEnabled: true, wasmEnabled: false })).toBe(false);
  });

  it("blocks dangerous shell commands by rule id", () => {
    const blocked = evaluateShellCommandPolicy("sudo rm -rf /");
    expect(blocked.blocked).toBe(true);
    if (blocked.blocked) {
      expect(blocked.ruleId).toBe("dangerous_rm_root");
    }
  });

  it("allows safe shell commands", () => {
    const decision = evaluateShellCommandPolicy("ls -la");
    expect(decision).toEqual({ blocked: false });
  });
});
