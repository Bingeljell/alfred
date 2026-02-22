import { describe, expect, it } from "vitest";
import { parseCommand } from "../../apps/gateway-orchestrator/src/builtins/command_parser";

describe("parseCommand", () => {
  it("parses reminder add command", () => {
    const parsed = parseCommand("/remind 2026-02-23T09:00:00Z call mom");
    expect(parsed?.kind).toBe("remind_add");
    if (parsed?.kind === "remind_add") {
      expect(parsed.text).toBe("call mom");
    }
  });

  it("parses job retry command", () => {
    const parsed = parseCommand("/job retry abc123");
    expect(parsed).toEqual({ kind: "job_retry", id: "abc123" });
  });

  it("returns null for unsupported input", () => {
    expect(parseCommand("hello world")).toBeNull();
  });
});
