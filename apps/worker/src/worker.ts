import type { Job } from "../../../packages/contracts/src";
import { FileBackedQueueStore } from "../../gateway-orchestrator/src/local_queue_store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type WorkerProcessor = (
  job: Job,
  context: {
    reportProgress: (progress: {
      message: string;
      step?: string;
      percent?: number;
      phase?: string;
      details?: Record<string, unknown>;
    }) => Promise<void>;
  }
) => Promise<Record<string, unknown>>;

export type WorkerStatusEvent = {
  jobId: string;
  workerId?: string;
  sessionId?: string;
  status: "running" | "progress" | "succeeded" | "failed" | "cancelled";
  summary?: string;
  step?: string;
  percent?: number;
  phase?: string;
  details?: Record<string, unknown>;
  responseText?: string;
};

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
  onStatusChange?: (event: WorkerStatusEvent) => Promise<void> | void;
}): WorkerHandle {
  const store = options.store;
  const workerId = options.workerId ?? "worker-1";
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const processor =
    options.processor ??
    (async (job: Job) => {
      return defaultProcessor(job);
    });
  const onStatusChange = options.onStatusChange;

  const sessionFromJob = (job: Job): string | undefined =>
    typeof job.payload.sessionId === "string" ? job.payload.sessionId : undefined;

  let active = true;

  const loop = async () => {
    while (active) {
      const claimed = await store.claimNextQueuedJob(workerId);
      if (!claimed) {
        await sleep(pollIntervalMs);
        continue;
      }

      try {
        const reportProgress = async (progress: {
          message: string;
          step?: string;
          percent?: number;
          phase?: string;
          details?: Record<string, unknown>;
        }): Promise<void> => {
          await store.updateJobProgress(claimed.job.id, progress);
          await onStatusChange?.({
            jobId: claimed.job.id,
            workerId,
            sessionId: sessionFromJob(claimed.job),
            status: "progress",
            summary: progress.message,
            step: progress.step,
            percent: progress.percent,
            phase: progress.phase,
            details: progress.details
          });
        };

        await onStatusChange?.({
          jobId: claimed.job.id,
          workerId,
          sessionId: sessionFromJob(claimed.job),
          status: "running"
        });

        const result = await processor(claimed.job, { reportProgress });
        const latest = await store.getJob(claimed.job.id);

        if (latest?.status === "cancelling") {
          const cancelled = await store.markCancelledAfterRun(claimed.job.id, result);
          await onStatusChange?.({
            jobId: claimed.job.id,
            workerId,
            sessionId: sessionFromJob(claimed.job),
            status: "cancelled",
            summary: typeof cancelled?.result?.summary === "string" ? cancelled.result.summary : undefined
          });
        } else {
          const completed = await store.completeJob(claimed.job.id, result);
          await onStatusChange?.({
            jobId: claimed.job.id,
            workerId,
            sessionId: sessionFromJob(claimed.job),
            status: "succeeded",
            summary: typeof completed?.result?.summary === "string" ? completed.result.summary : undefined,
            responseText: typeof completed?.result?.responseText === "string" ? completed.result.responseText : undefined
          });
        }
      } catch (error) {
        await store.failJob(claimed.job.id, {
          code: "processor_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        });
        await onStatusChange?.({
          jobId: claimed.job.id,
          workerId,
          sessionId: sessionFromJob(claimed.job),
          status: "failed",
          summary: error instanceof Error ? error.message : String(error)
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
