import type { WorkerStatusEvent } from "../worker";

export function createWorkerStatusHandler(input: {
  notificationStore: {
    enqueue: (item: {
      sessionId: string;
      status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      text?: string;
      jobId?: string;
      type?: "text" | "file";
      filePath?: string;
      fileName?: string;
      mimeType?: string;
      caption?: string;
    }) => Promise<unknown>;
  };
  store: {
    getJob: (jobId: string) => Promise<{
      id: string;
      payload: Record<string, unknown>;
      result?: Record<string, unknown>;
    } | null>;
  };
  supervisorStore: {
    updateChildByJob: (
      jobId: string,
      input: {
        status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
        summary?: string;
        error?: string;
        retriesUsed?: number;
      }
    ) => Promise<{
      run: any;
      transitionedToTerminal: boolean;
    } | null>;
    summarize: (run: any) => string;
  };
}): (event: WorkerStatusEvent) => Promise<void> {
  const jobNotificationState = new Map<string, { lastProgressAt: number; lastProgressText: string }>();

  return async (event: WorkerStatusEvent): Promise<void> => {
    if (!event.sessionId) {
      return;
    }

    const summary = event.summary ? ` (${event.summary})` : "";
    const status = event.status === "progress" ? "running" : event.status;
    const now = Date.now();
    const notifyState = jobNotificationState.get(event.jobId) ?? { lastProgressAt: 0, lastProgressText: "" };

    let text: string | null = null;
    if (event.status === "running") {
      text = `Working on job ${event.jobId}...`;
    } else if (event.status === "progress") {
      const nextText = String(event.summary ?? "still working");
      const shouldSend =
        now - notifyState.lastProgressAt >= 45_000 && nextText.trim() && nextText !== notifyState.lastProgressText;
      if (shouldSend) {
        text = `Still working on job ${event.jobId}: ${nextText}`;
        notifyState.lastProgressAt = now;
        notifyState.lastProgressText = nextText;
        jobNotificationState.set(event.jobId, notifyState);
      }
    } else if (event.status === "succeeded" && event.responseText) {
      text = event.responseText;
    } else {
      text = `Job ${event.jobId} is ${event.status}${summary}`;
    }

    if (text) {
      await input.notificationStore.enqueue({
        sessionId: event.sessionId,
        jobId: event.jobId,
        status,
        text
      });
    }

    const job = await input.store.getJob(event.jobId);
    const supervisorId =
      job && typeof job.payload.supervisorId === "string" && job.payload.supervisorId.trim()
        ? job.payload.supervisorId.trim()
        : "";
    if (supervisorId) {
      const update = await input.supervisorStore.updateChildByJob(event.jobId, {
        status: event.status === "progress" ? "running" : event.status,
        summary: event.summary,
        error: event.status === "failed" ? event.summary : undefined,
        retriesUsed:
          job && typeof job.result?.retriesUsed === "number" && Number.isFinite(job.result?.retriesUsed)
            ? Math.max(0, Math.floor(job.result.retriesUsed))
            : undefined
      });
      if (update && update.transitionedToTerminal) {
        const runSessionId =
          update.run && typeof update.run.sessionId === "string" && update.run.sessionId.trim()
            ? update.run.sessionId.trim()
            : event.sessionId;
        const runStatus = update.run && typeof update.run.status === "string" ? update.run.status : "failed";
        await input.notificationStore.enqueue({
          sessionId: runSessionId,
          status: runStatus === "completed" ? "succeeded" : "failed",
          jobId: event.jobId,
          text: input.supervisorStore.summarize(update.run)
        });
      }
    }

    if (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") {
      jobNotificationState.delete(event.jobId);
    }
  };
}
