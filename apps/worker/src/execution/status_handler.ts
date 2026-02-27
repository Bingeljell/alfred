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
  const jobNotificationState = new Map<
    string,
    { lastProgressAt: number; lastProgressText: string; lastProgressPhase: string; progressCount: number }
  >();

  return async (event: WorkerStatusEvent): Promise<void> => {
    if (!event.sessionId) {
      return;
    }

    const summary = event.summary ? ` (${event.summary})` : "";
    const status = event.status === "progress" ? "running" : event.status;
    const now = Date.now();
    const notifyState = jobNotificationState.get(event.jobId) ?? {
      lastProgressAt: 0,
      lastProgressText: "",
      lastProgressPhase: "",
      progressCount: 0
    };

    let text: string | null = null;
    if (event.status === "running") {
      const workerSuffix = event.workerId ? ` on ${event.workerId}` : "";
      text = `On it. This task is running on the worker queue${workerSuffix}.`;
    } else if (event.status === "progress") {
      const nextText = normalizeProgressText(String(event.summary ?? "still working"), event);
      const changed = nextText.trim() && nextText !== notifyState.lastProgressText;
      const sinceLast = now - notifyState.lastProgressAt;
      const phase = typeof event.phase === "string" ? event.phase : "";
      const phaseChanged = Boolean(phase) && phase !== notifyState.lastProgressPhase;
      const shouldSend =
        (notifyState.progressCount === 0 && changed) ||
        (phaseChanged && changed) ||
        (changed && sinceLast >= 15_000) ||
        (!changed && sinceLast >= 30_000);
      if (shouldSend) {
        text = nextText;
        notifyState.lastProgressAt = now;
        notifyState.lastProgressText = nextText;
        notifyState.lastProgressPhase = phase;
        notifyState.progressCount += 1;
        jobNotificationState.set(event.jobId, notifyState);
      }
    } else if (event.status === "succeeded" && event.responseText) {
      text = event.responseText;
    } else {
      text = event.status === "failed" ? `I hit an error while running this task${summary}` : `Job ${event.jobId} is ${event.status}${summary}`;
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

function normalizeProgressText(raw: string, event: WorkerStatusEvent): string {
  const text = raw.trim();
  if (!text) {
    return "Still running. No new milestone yet.";
  }
  const details = event.details && typeof event.details === "object" ? event.details : {};
  const elapsedSec =
    typeof details.elapsedSec === "number" && Number.isFinite(details.elapsedSec) ? Math.max(0, Math.floor(details.elapsedSec)) : null;

  if (event.phase === "retrieve" || /retrieving sources via/i.test(text)) {
    const provider = typeof details.provider === "string" ? details.provider : null;
    const hitCount = typeof details.hitCount === "number" ? details.hitCount : null;
    const domainCount = typeof details.domainCount === "number" ? details.domainCount : null;
    if (hitCount !== null && domainCount !== null) {
      return `Retrieved ${hitCount} sources across ${domainCount} domains${provider ? ` via ${provider}` : ""}.`;
    }
    return elapsedSec !== null ? `${text} (${elapsedSec}s elapsed)` : text;
  }
  if (event.phase === "fallback_retrieve" || /coverage looks weak/i.test(text)) {
    return text;
  }
  if (event.phase === "rank") {
    return text;
  }
  if (event.phase === "synth") {
    return elapsedSec !== null ? `${text} (${elapsedSec}s elapsed)` : text;
  }
  return text;
}
