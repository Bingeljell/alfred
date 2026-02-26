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
    expect(parseCommand("/auth limits")).toEqual({ kind: "auth_limits" });
    expect(parseCommand("/auth disconnect")).toEqual({ kind: "auth_disconnect" });
  });

  it("parses capability and policy commands", () => {
    expect(parseCommand("/policy")).toEqual({ kind: "policy_status" });
    expect(parseCommand("/approval")).toEqual({ kind: "approval_pending" });
    expect(parseCommand("/approval pending")).toEqual({ kind: "approval_pending" });
    expect(parseCommand("/web latest openai oauth docs")).toEqual({
      kind: "web_search",
      query: "latest openai oauth docs",
      provider: undefined
    });
    expect(parseCommand("/web --provider=brave latest ai news")).toEqual({
      kind: "web_search",
      query: "latest ai news",
      provider: "brave"
    });
    expect(parseCommand("/web --provider=searxng latest ai news")).toEqual({
      kind: "web_search",
      query: "latest ai news",
      provider: "searxng"
    });
    expect(parseCommand("/web --provider=brightdata latest ai news")).toEqual({
      kind: "web_search",
      query: "latest ai news",
      provider: "brightdata"
    });
    expect(parseCommand("/write notes/today.md Remember to call mom")).toEqual({
      kind: "file_write",
      relativePath: "notes/today.md",
      text: "Remember to call mom"
    });
    expect(parseCommand("/file write notes/today.txt Remember to call mom")).toEqual({
      kind: "file_write",
      relativePath: "notes/today.txt",
      text: "Remember to call mom"
    });
    expect(parseCommand("/file send notes/today.md")).toEqual({
      kind: "file_send",
      relativePath: "notes/today.md"
    });
    expect(parseCommand("/file send notes/today.md daily recap")).toEqual({
      kind: "file_send",
      relativePath: "notes/today.md",
      caption: "daily recap"
    });
    expect(parseCommand("/calendar add 2026-02-23T09:00:00Z team sync")).toEqual({
      kind: "calendar_add",
      startsAt: "2026-02-23T09:00:00Z",
      title: "team sync"
    });
    expect(parseCommand("/calendar list")).toEqual({ kind: "calendar_list" });
    expect(parseCommand("/calendar cancel cal-1")).toEqual({ kind: "calendar_cancel", id: "cal-1" });
    expect(parseCommand("/supervise web compare sd models")).toEqual({
      kind: "supervise_web",
      query: "compare sd models",
      providers: undefined,
      maxRetries: undefined,
      timeBudgetMs: undefined,
      tokenBudget: undefined
    });
    expect(
      parseCommand(
        "/supervise web --providers=openai,brave --max-retries=2 --time-budget-ms=90000 --token-budget=6000 compare sd models"
      )
    ).toEqual({
      kind: "supervise_web",
      query: "compare sd models",
      providers: ["openai", "brave"],
      maxRetries: 2,
      timeBudgetMs: 90000,
      tokenBudget: 6000
    });
    expect(parseCommand("/supervise web --providers=searxng,openai compare sd models")).toEqual({
      kind: "supervise_web",
      query: "compare sd models",
      providers: ["searxng", "openai"],
      maxRetries: undefined,
      timeBudgetMs: undefined,
      tokenBudget: undefined
    });
    expect(parseCommand("/supervise web --providers=brightdata,searxng compare sd models")).toEqual({
      kind: "supervise_web",
      query: "compare sd models",
      providers: ["brightdata", "searxng"],
      maxRetries: undefined,
      timeBudgetMs: undefined,
      tokenBudget: undefined
    });
    expect(parseCommand("/supervisor status sup-123")).toEqual({ kind: "supervisor_status", id: "sup-123" });
  });

  it("returns null for unsupported input", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("parses explicit reject command", () => {
    expect(parseCommand("reject abc123")).toEqual({ kind: "reject", token: "abc123" });
    expect(parseCommand("/approve abc123")).toEqual({ kind: "approve", token: "abc123" });
    expect(parseCommand("/reject abc123")).toEqual({ kind: "reject", token: "abc123" });
  });
});
