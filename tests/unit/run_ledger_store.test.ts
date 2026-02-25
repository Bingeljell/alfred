import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunLedgerStore } from "../../apps/gateway-orchestrator/src/builtins/run_ledger_store";

describe("RunLedgerStore", () => {
  it("creates run records with phase transitions and completion", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-run-ledger-unit-"));
    const store = new RunLedgerStore(stateDir);
    await store.ensureReady();

    const started = await store.startRun({
      sessionKey: "owner@s.whatsapp.net",
      queueMode: "steer",
      idempotencyKey: "idempotency-1",
      model: "openai-codex/default",
      provider: "openai-codex",
      toolPolicySnapshot: { approvalMode: "balanced" },
      skillsSnapshot: {
        hash: "abc123",
        content: ["intent_planner", "web_search"]
      }
    });
    expect(started.acquired).toBe(true);

    const runId = started.run.runId;
    await store.transitionPhase(runId, "plan", "planned");
    await store.appendEvent(runId, "note", "policy", "policy checked", { ok: true });
    await store.completeRun(runId, "completed", "done");

    const loaded = await store.getRun(runId);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.currentPhase).toBe("completed");
    expect(loaded?.spec.version).toBe(1);
    expect(loaded?.events.some((event) => event.type === "phase" && event.phase === "plan")).toBe(true);
    expect(loaded?.events.some((event) => event.type === "note")).toBe(true);
    expect(loaded?.events.some((event) => event.type === "completed")).toBe(true);
  });

  it("blocks concurrent active run in same session and records blocked run", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-run-ledger-block-unit-"));
    const store = new RunLedgerStore(stateDir);
    await store.ensureReady();

    const first = await store.startRun({
      sessionKey: "session-1",
      queueMode: "steer",
      idempotencyKey: "k-1"
    });
    expect(first.acquired).toBe(true);

    const second = await store.startRun({
      sessionKey: "session-1",
      queueMode: "steer",
      idempotencyKey: "k-2"
    });
    expect(second.acquired).toBe(false);
    expect(second.activeRunId).toBe(first.run.runId);
    expect(second.run.status).toBe("blocked");
  });

  it("reuses idempotency key for same session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-run-ledger-idempotent-unit-"));
    const store = new RunLedgerStore(stateDir);
    await store.ensureReady();

    const first = await store.startRun({
      sessionKey: "session-2",
      queueMode: "steer",
      idempotencyKey: "k-fixed"
    });
    const again = await store.startRun({
      sessionKey: "session-2",
      queueMode: "steer",
      idempotencyKey: "k-fixed"
    });

    expect(again.reused).toBe(true);
    expect(again.run.runId).toBe(first.run.runId);
  });
});

