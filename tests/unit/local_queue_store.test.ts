import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";

describe("FileBackedQueueStore", () => {
  it("increments retryAttempt on retried jobs", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-queue-retry-unit-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();

    const created = await store.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        maxRetries: 2
      },
      priority: 5
    });

    await store.failJob(created.id, {
      code: "processor_failure",
      message: "temporary",
      retryable: true
    });

    const retried = await store.retryJob(created.id);
    expect(retried).not.toBeNull();
    expect(retried?.retryOf).toBe(created.id);
    expect(retried?.payload?.retryAttempt).toBe(1);
  });

  it("recovers stale running jobs via watchdog", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-queue-watchdog-unit-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();

    const created = await store.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "web_search",
        query: "test"
      },
      priority: 5
    });

    await store.claimNextQueuedJob("worker-watchdog-unit");

    const jobPath = path.join(stateDir, "jobs", `${created.id}.json`);
    const raw = await fs.readFile(jobPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.updatedAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(jobPath, JSON.stringify(parsed, null, 2), "utf8");

    const recovered = await store.recoverStuckJobs({
      runningTimeoutMs: 1_000,
      cancellingTimeoutMs: 1_000
    });

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.error?.code).toBe("watchdog_timeout");
  });
});
