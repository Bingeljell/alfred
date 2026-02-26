import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSpecV1 } from "../../packages/contracts/src";
import { RunSpecStore } from "../../apps/gateway-orchestrator/src/builtins/run_spec_store";

function makeSpec(runId: string): RunSpecV1 {
  return {
    version: 1,
    id: runId,
    goal: "unit test run spec",
    metadata: {},
    steps: [
      {
        id: "search",
        type: "web.search",
        name: "Search",
        input: { query: "unit test", provider: "searxng" }
      },
      {
        id: "write",
        type: "file.write",
        name: "Write",
        input: { fileFormat: "md", fileName: "unit.md" },
        approval: { required: true, capability: "file_write" }
      }
    ]
  };
}

describe("RunSpecStore", () => {
  it("tracks approvals, step updates, and timeline events", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-runspec-store-unit-"));
    const store = new RunSpecStore(stateDir);
    await store.ensureReady();

    const runId = "run-spec-store-test";
    const spec = makeSpec(runId);
    await store.put({
      runId,
      sessionId: "owner@s.whatsapp.net",
      spec,
      status: "awaiting_approval",
      approvedStepIds: []
    });

    const created = await store.get(runId);
    expect(created?.status).toBe("awaiting_approval");
    expect(created?.stepStates.write?.status).toBe("approval_required");

    await store.grantStepApproval(runId, "write");
    await store.updateStep(runId, "search", {
      status: "running",
      message: "search in progress",
      attempts: 1
    });
    await store.updateStep(runId, "search", {
      status: "completed",
      message: "search completed",
      output: { provider: "searxng" }
    });
    await store.setStatus(runId, "completed", { message: "done" });

    const final = await store.get(runId);
    expect(final?.status).toBe("completed");
    expect(final?.approvedStepIds).toContain("write");
    expect(final?.stepStates.write?.status).toBe("approved");
    expect(final?.stepStates.search?.status).toBe("completed");
    expect(final?.events.some((event) => event.type === "approval_granted" && event.stepId === "write")).toBe(true);
    expect(final?.events.some((event) => event.type === "completed")).toBe(true);
  });
});
