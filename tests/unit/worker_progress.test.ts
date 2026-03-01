import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { startWorker, type WorkerStatusEvent } from "../../apps/worker/src/worker";
import { waitFor } from "../helpers/wait_for";

describe("worker progress reporting", () => {
  it("persists progress and emits progress status events", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-worker-progress-unit-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();

    const created = await store.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "web_search",
        query: "test query"
      },
      priority: 5
    });

    const events: WorkerStatusEvent[] = [];
    const worker = startWorker({
      store,
      workerId: "worker-progress-unit",
      pollIntervalMs: 10,
      processor: async (_job, context) => {
        await context.reportProgress({
          step: "searching",
          message: "Searching provider...",
          percent: 25
        });
        return {
          summary: "done",
          responseText: "Final output"
        };
      },
      onStatusChange: async (event) => {
        events.push(event);
      }
    });

    const completed = await waitFor(async () => {
      const job = await store.getJob(created.id);
      if (!job || job.status !== "succeeded") {
        return null;
      }
      return job;
    });
    await waitFor(async () =>
      events.some((event) => event.status === "succeeded" && event.responseText === "Final output") ? true : null
    );

    expect(completed.progress?.message).toBe("Searching provider...");
    expect(events.some((event) => event.status === "progress" && event.summary === "Searching provider...")).toBe(true);
    expect(events.some((event) => event.status === "succeeded" && event.responseText === "Final output")).toBe(true);

    await worker.stop();
  });

  it("automatically retries retryable processor failures within maxRetries budget", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-worker-retry-unit-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();

    await store.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "best terminals",
        maxRetries: 1
      },
      priority: 5
    });

    let attempts = 0;
    const events: WorkerStatusEvent[] = [];
    const worker = startWorker({
      store,
      workerId: "worker-retry-unit",
      pollIntervalMs: 10,
      processor: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("fetch failed");
        }
        return {
          summary: "retry_success",
          responseText: "Recovered after transient failure."
        };
      },
      onStatusChange: async (event) => {
        events.push(event);
      }
    });

    await waitFor(async () => {
      const jobs = await store.listJobs();
      const succeeded = jobs.find((job) => job.status === "succeeded");
      if (!succeeded) {
        return null;
      }
      return succeeded;
    });

    const jobs = await store.listJobs();
    const failed = jobs.filter((job) => job.status === "failed");
    const succeeded = jobs.filter((job) => job.status === "succeeded");
    const retryJob = jobs.find((job) => job.retryOf && job.status === "succeeded");

    expect(attempts).toBe(2);
    expect(failed.length).toBe(1);
    expect(succeeded.length).toBe(1);
    expect(retryJob?.payload?.retryAttempt).toBe(1);
    expect(
      events.some(
        (event) => event.status === "progress" && String(event.summary ?? "").includes("Retrying automatically")
      )
    ).toBe(true);

    await worker.stop();
  });
});
