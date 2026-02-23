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

  it("parses note commands", () => {
    const add = parseCommand("/note add remember this");
    const list = parseCommand("/note list");

    expect(add).toEqual({ kind: "note_add", text: "remember this" });
    expect(list).toEqual({ kind: "note_list" });
  });

  it("parses oauth commands", () => {
    expect(parseCommand("/auth connect")).toEqual({ kind: "auth_connect" });
    expect(parseCommand("/auth status")).toEqual({ kind: "auth_status" });
    expect(parseCommand("/auth disconnect")).toEqual({ kind: "auth_disconnect" });
  });

  it("returns null for unsupported input", () => {
    expect(parseCommand("hello world")).toBeNull();
  });
});
