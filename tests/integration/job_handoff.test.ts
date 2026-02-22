import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { startWorker } from "../../apps/worker/src/worker";
import { waitFor } from "../helpers/wait_for";

describe("job handoff integration", () => {
  it("moves a queued job from gateway to worker and completes it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-phase1-int-"));
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();
    const service = new GatewayService(store);
    const worker = startWorker({
      store,
      workerId: "worker-int",
      pollIntervalMs: 20
    });

    const createResponse = await service.createJob({
      type: "stub_task",
      payload: { action: "integration-check" },
      priority: 3
    });

    expect(createResponse.status).toBe("queued");
    const jobId = createResponse.jobId;

    const completed = await waitFor(async () => {
      const job = await service.getJob(jobId);
      if (!job || job.status !== "succeeded") {
        return null;
      }
      return job;
    });

    expect(completed.result?.summary).toContain("processed:integration-check");

    await worker.stop();
  });
});
