import type { Job } from "../../../packages/contracts/src";
import { FileBackedQueueStore } from "../../gateway-orchestrator/src/local_queue_store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type WorkerProcessor = (job: Job) => Promise<Record<string, unknown>>;

export type WorkerHandle = {
  stop: () => Promise<void>;
};

export function defaultProcessor(job: Job): Promise<Record<string, unknown>> {
  const action = String(job.payload.action ?? job.payload.text ?? job.type);
  return Promise.resolve({
    summary: `processed:${action}`,
    processedAt: new Date().toISOString()
  });
}

export function startWorker(options: {
  store: FileBackedQueueStore;
  workerId?: string;
  pollIntervalMs?: number;
  processor?: WorkerProcessor;
}): WorkerHandle {
  const store = options.store;
  const workerId = options.workerId ?? "worker-1";
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const processor = options.processor ?? defaultProcessor;

  let active = true;

  const loop = async () => {
    while (active) {
      const claimed = await store.claimNextQueuedJob(workerId);
      if (!claimed) {
        await sleep(pollIntervalMs);
        continue;
      }

      try {
        const result = await processor(claimed.job);
        const latest = await store.getJob(claimed.job.id);

        if (latest?.status === "cancelling") {
          await store.markCancelledAfterRun(claimed.job.id, result);
        } else {
          await store.completeJob(claimed.job.id, result);
        }
      } catch (error) {
        await store.failJob(claimed.job.id, {
          code: "processor_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        });
      } finally {
        await store.releaseClaim(claimed.job.id);
      }
    }
  };

  void loop();

  return {
    stop: async () => {
      active = false;
      await sleep(pollIntervalMs + 10);
    }
  };
}
