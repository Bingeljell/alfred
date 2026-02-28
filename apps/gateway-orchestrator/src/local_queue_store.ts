import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, JobCreate, JobStatus, Receipt } from "../../../packages/contracts/src";
import { JobSchema, ReceiptSchema } from "../../../packages/contracts/src";

export type ClaimedJob = {
  job: Job;
};

export class FileBackedQueueStore {
  private readonly jobsDir: string;
  private readonly receiptsDir: string;
  private readonly locksDir: string;
  private readonly eventsPath: string;

  constructor(private readonly stateDir: string) {
    this.jobsDir = path.join(stateDir, "jobs");
    this.receiptsDir = path.join(stateDir, "receipts");
    this.locksDir = path.join(stateDir, "locks");
    this.eventsPath = path.join(stateDir, "events.jsonl");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.jobsDir, { recursive: true });
    await fs.mkdir(this.receiptsDir, { recursive: true });
    await fs.mkdir(this.locksDir, { recursive: true });
    try {
      await fs.access(this.eventsPath);
    } catch {
      await fs.writeFile(this.eventsPath, "", "utf8");
    }
  }

  async createJob(input: JobCreate): Promise<Job> {
    await this.ensureReady();

    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload,
      priority: input.priority,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      requestedSkill: input.requestedSkill
    };

    await this.writeJob(job);
    await this.appendEvent({ jobId: job.id, at: now, step: "job.queued" });

    return job;
  }

  async retryJob(jobId: string): Promise<Job | null> {
    const original = await this.getJob(jobId);
    if (!original) {
      return null;
    }

    if (!["failed", "cancelled"].includes(original.status)) {
      return null;
    }

    const now = new Date().toISOString();
    const nextPayload =
      original.payload && typeof original.payload === "object"
        ? {
            ...original.payload,
            retryAttempt: clampInt((original.payload as Record<string, unknown>).retryAttempt, 0, 100, 0) + 1,
            retryRootJobId:
              typeof (original.payload as Record<string, unknown>).retryRootJobId === "string"
                ? String((original.payload as Record<string, unknown>).retryRootJobId)
                : original.retryOf ?? original.id
          }
        : original.payload;

    const retried: Job = {
      id: randomUUID(),
      type: original.type,
      payload: nextPayload,
      priority: original.priority,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      requestedSkill: original.requestedSkill,
      retryOf: original.id
    };

    await this.writeJob(retried);
    await this.appendEvent({
      jobId: retried.id,
      at: now,
      step: "job.queued",
      detail: `retryOf=${original.id}`
    });

    return retried;
  }

  async recoverStuckJobs(input?: {
    runningTimeoutMs?: number;
    cancellingTimeoutMs?: number;
  }): Promise<Job[]> {
    const runningTimeoutMs = clampInt(input?.runningTimeoutMs, 30_000, 24 * 60 * 60 * 1000, 10 * 60 * 1000);
    const cancellingTimeoutMs = clampInt(input?.cancellingTimeoutMs, 10_000, 24 * 60 * 60 * 1000, 90_000);
    const now = Date.now();
    const jobs = await this.listJobs();
    const recovered: Job[] = [];

    for (const job of jobs) {
      if (job.status !== "running" && job.status !== "cancelling") {
        continue;
      }
      const lastTouchedAt = Date.parse(job.updatedAt || job.startedAt || job.createdAt);
      if (!Number.isFinite(lastTouchedAt)) {
        continue;
      }
      const elapsed = now - lastTouchedAt;
      const threshold = job.status === "running" ? runningTimeoutMs : cancellingTimeoutMs;
      if (elapsed < threshold) {
        continue;
      }
      const failed = await this.failJob(job.id, {
        code: "watchdog_timeout",
        message: `Job exceeded ${Math.floor(threshold / 1000)}s without heartbeat`,
        retryable: false
      });
      if (failed) {
        recovered.push(failed);
      }
      await this.releaseClaim(job.id);
    }

    return recovered;
  }

  async getJob(jobId: string): Promise<Job | null> {
    await this.ensureReady();

    const jobPath = this.jobPath(jobId);
    try {
      const raw = await fs.readFile(jobPath, "utf8");
      return JobSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async listJobs(): Promise<Job[]> {
    await this.ensureReady();
    const files = await fs.readdir(this.jobsDir);
    const jobs: Job[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const raw = await fs.readFile(path.join(this.jobsDir, file), "utf8");
      jobs.push(JobSchema.parse(JSON.parse(raw)));
    }

    return jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async claimNextQueuedJob(workerId: string): Promise<ClaimedJob | null> {
    const jobs = await this.listJobs();

    for (const job of jobs) {
      if (job.status !== "queued") {
        continue;
      }

      if (!(await this.tryAcquireLock(job.id))) {
        continue;
      }

      const latest = await this.getJob(job.id);
      if (!latest || latest.status !== "queued") {
        await this.releaseClaim(job.id);
        continue;
      }

      const now = new Date().toISOString();
      const running: Job = {
        ...latest,
        status: "running",
        startedAt: now,
        updatedAt: now,
        workerId
      };

      await this.writeJob(running);
      await this.appendEvent({ jobId: running.id, at: now, step: "job.running", detail: `worker=${workerId}` });

      return { job: running };
    }

    return null;
  }

  async completeJob(jobId: string, result: Record<string, unknown>): Promise<Job | null> {
    const latest = await this.getJob(jobId);
    if (!latest) {
      return null;
    }

    const now = new Date().toISOString();
    const completed: Job = {
      ...latest,
      status: "succeeded",
      updatedAt: now,
      endedAt: now,
      result
    };

    await this.writeJob(completed);
    await this.appendEvent({ jobId, at: now, step: "job.succeeded" });
    await this.writeReceipt(completed);
    return completed;
  }

  async failJob(
    jobId: string,
    error: {
      code: string;
      message: string;
      retryable?: boolean;
    }
  ): Promise<Job | null> {
    const latest = await this.getJob(jobId);
    if (!latest) {
      return null;
    }

    const now = new Date().toISOString();
    const failed: Job = {
      ...latest,
      status: "failed",
      updatedAt: now,
      endedAt: now,
      error: {
        code: error.code,
        message: error.message,
        retryable: Boolean(error.retryable)
      }
    };

    await this.writeJob(failed);
    await this.appendEvent({ jobId, at: now, step: "job.failed", detail: error.code });
    await this.writeReceipt(failed);
    return failed;
  }

  async cancelJob(jobId: string): Promise<Job | null> {
    const latest = await this.getJob(jobId);
    if (!latest) {
      return null;
    }

    const now = new Date().toISOString();

    if (latest.status === "queued") {
      const cancelled: Job = {
        ...latest,
        status: "cancelled",
        updatedAt: now,
        endedAt: now
      };
      await this.writeJob(cancelled);
      await this.appendEvent({ jobId, at: now, step: "job.cancelled", detail: "cancelled-before-start" });
      await this.writeReceipt(cancelled);
      return cancelled;
    }

    if (latest.status === "running") {
      const cancelling: Job = {
        ...latest,
        status: "cancelling",
        updatedAt: now
      };
      await this.writeJob(cancelling);
      await this.appendEvent({ jobId, at: now, step: "job.cancelling" });
      return cancelling;
    }

    return latest;
  }

  async markCancelledAfterRun(jobId: string, partialResult?: Record<string, unknown>): Promise<Job | null> {
    const latest = await this.getJob(jobId);
    if (!latest) {
      return null;
    }

    const now = new Date().toISOString();
    const cancelled: Job = {
      ...latest,
      status: "cancelled",
      updatedAt: now,
      endedAt: now,
      result: partialResult ?? latest.result
    };

    await this.writeJob(cancelled);
    await this.appendEvent({ jobId, at: now, step: "job.cancelled", detail: "cancelled-during-run" });
    await this.writeReceipt(cancelled);
    return cancelled;
  }

  async updateJobProgress(
    jobId: string,
    progress: {
      message: string;
      step?: string;
      percent?: number;
      phase?: string;
      details?: Record<string, unknown>;
    }
  ): Promise<Job | null> {
    const latest = await this.getJob(jobId);
    if (!latest) {
      return null;
    }

    const now = new Date().toISOString();
    const next: Job = {
      ...latest,
      updatedAt: now,
      progress: {
        at: now,
        message: progress.message,
        step: progress.step,
        percent: typeof progress.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : undefined,
        phase: typeof progress.phase === "string" && progress.phase.trim() ? progress.phase.trim() : undefined,
        details: progress.details && typeof progress.details === "object" ? progress.details : undefined
      }
    };

    await this.writeJob(next);
    const detailParts = [progress.step ? `step=${progress.step}` : undefined, progress.phase ? `phase=${progress.phase}` : undefined, progress.message]
      .filter((item) => !!item)
      .join(" | ");
    await this.appendEvent({ jobId, at: now, step: "job.progress", detail: detailParts });
    return next;
  }

  async statusCounts(): Promise<Record<JobStatus, number>> {
    const jobs = await this.listJobs();
    const counts: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelling: 0,
      cancelled: 0
    };

    for (const job of jobs) {
      counts[job.status] += 1;
    }

    return counts;
  }

  async releaseClaim(jobId: string): Promise<void> {
    const lockPath = this.lockPath(jobId);
    try {
      await fs.unlink(lockPath);
    } catch {
      // no-op
    }
  }

  private jobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private lockPath(jobId: string): string {
    return path.join(this.locksDir, `${jobId}.lock`);
  }

  private receiptPath(jobId: string): string {
    return path.join(this.receiptsDir, `${jobId}.json`);
  }

  private async tryAcquireLock(jobId: string): Promise<boolean> {
    try {
      const handle = await fs.open(this.lockPath(jobId), "wx");
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }

  private async writeJob(job: Job): Promise<void> {
    const parsed = JobSchema.parse(job);
    const destination = this.jobPath(job.id);
    const temp = `${destination}.tmp`;
    await fs.writeFile(temp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(temp, destination);
  }

  private async writeReceipt(job: Job): Promise<void> {
    const queuedAt = job.createdAt;
    const endedAt = job.endedAt ?? new Date().toISOString();
    const startedAt = job.startedAt;

    const durationMs = startedAt
      ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : 0;

    const statusMap: Record<JobStatus, Receipt["status"]> = {
      queued: "partial",
      running: "partial",
      cancelling: "partial",
      succeeded: "success",
      failed: "failed",
      cancelled: "cancelled"
    };

    const receipt: Receipt = {
      receiptId: `r_${job.id}`,
      jobId: job.id,
      sessionId: "local-session",
      status: statusMap[job.status],
      actions: [
        { at: queuedAt, step: "job.queued" },
        ...(job.startedAt ? [{ at: job.startedAt, step: "job.started" }] : []),
        { at: endedAt, step: `job.${job.status}` }
      ],
      timing: {
        queuedAt,
        startedAt,
        endedAt,
        durationMs
      },
      outputSummary: typeof job.result?.summary === "string" ? job.result.summary : undefined
    };

    const parsed = ReceiptSchema.parse(receipt);
    const destination = this.receiptPath(job.id);
    const temp = `${destination}.tmp`;
    await fs.writeFile(temp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(temp, destination);
  }

  private async appendEvent(event: { jobId: string; at: string; step: string; detail?: string }): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    await fs.appendFile(this.eventsPath, line, "utf8");
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const value = Math.floor(numeric);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
