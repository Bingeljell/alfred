import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { startWorker } from "../../apps/worker/src/worker";
import { waitFor } from "../helpers/wait_for";

describe("phase 1 smoke", () => {
  it("boots gateway + worker and completes a deterministic async job", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-phase1-smoke-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();
    const service = new GatewayService(store);
    const worker = startWorker({
      store,
      workerId: "worker-smoke",
      pollIntervalMs: 20
    });

    const health = await service.health();
    expect(health.status).toBe("ok");

    const inbound = await service.handleInbound({
      sessionId: "user-1",
      text: "phase-1 smoke",
      requestJob: true
    });

    expect(inbound.mode).toBe("async-job");
    const jobId = inbound.jobId as string;

    const completed = await waitFor(async () => {
      const job = await service.getJob(jobId);
      if (!job || job.status !== "succeeded") {
        return null;
      }
      return job;
    });

    expect(completed.result?.summary).toContain("processed:phase-1 smoke");

    await worker.stop();
  });
});
