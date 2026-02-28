import fs from "node:fs/promises";
import path from "node:path";
import type { RunSpecStepStateStatus, RunSpecV1 } from "../../../../packages/contracts/src";

export type RunSpecStepState = {
  stepId: string;
  status: RunSpecStepStateStatus;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  message?: string;
  output?: Record<string, unknown>;
};

export type RunSpecTimelineEvent = {
  seq: number;
  at: string;
  type: "started" | "step_status" | "note" | "approval_requested" | "approval_granted" | "completed" | "failed" | "cancelled";
  stepId?: string;
  message?: string;
  payload?: Record<string, unknown>;
};

export type RunSpecRecord = {
  runId: string;
  sessionId: string;
  jobId?: string;
  status: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
  spec: RunSpecV1;
  approvedStepIds: string[];
  stepStates: Record<string, RunSpecStepState>;
  events: RunSpecTimelineEvent[];
  createdAt: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class RunSpecStore {
  private readonly dirPath: string;

  constructor(stateDir: string) {
    this.dirPath = path.join(stateDir, "builtins", "run_specs");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
  }

  async put(input: {
    runId: string;
    sessionId: string;
    spec: RunSpecV1;
    status: RunSpecRecord["status"];
    approvedStepIds?: string[];
    jobId?: string;
  }): Promise<RunSpecRecord> {
    const existing = await this.get(input.runId);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const approvedStepIds = uniqueStepIds(input.approvedStepIds ?? existing?.approvedStepIds ?? []);

    const stepStates = existing?.stepStates ?? createInitialStepStates(input.spec, approvedStepIds);
    for (const stepId of approvedStepIds) {
      const current = stepStates[stepId];
      if (!current) {
        continue;
      }
      if (current.status === "pending" || current.status === "approval_required") {
        stepStates[stepId] = {
          ...current,
          status: "approved",
          message: current.message ?? "Approved before execution"
        };
      }
    }

    const record: RunSpecRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      jobId: input.jobId ?? existing?.jobId,
      status: input.status,
      spec: input.spec,
      approvedStepIds,
      stepStates,
      events: existing?.events ?? [
        {
          seq: 1,
          at: createdAt,
          type: "started",
          message: "RunSpec created"
        }
      ],
      createdAt,
      updatedAt
    };

    await this.write(record);
    return record;
  }

  async get(runId: string): Promise<RunSpecRecord | null> {
    await this.ensureReady();
    try {
      const raw = await fs.readFile(this.filePath(runId), "utf8");
      return JSON.parse(raw) as RunSpecRecord;
    } catch {
      return null;
    }
  }

  async setStatus(
    runId: string,
    status: RunSpecRecord["status"],
    options?: { message?: string; payload?: Record<string, unknown> }
  ): Promise<RunSpecRecord | null> {
    const record = await this.get(runId);
    if (!record) {
      return null;
    }
    record.status = status;
    record.updatedAt = nowIso();
    const eventType = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "note";
    record.events.push({
      seq: record.events.length + 1,
      at: record.updatedAt,
      type: eventType,
      message: options?.message,
      payload: options?.payload
    });
    await this.write(record);
    return record;
  }

  async appendEvent(
    runId: string,
    input: {
      type: RunSpecTimelineEvent["type"];
      stepId?: string;
      message?: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<RunSpecRecord | null> {
    const record = await this.get(runId);
    if (!record) {
      return null;
    }
    record.updatedAt = nowIso();
    record.events.push({
      seq: record.events.length + 1,
      at: record.updatedAt,
      type: input.type,
      stepId: input.stepId,
      message: input.message,
      payload: input.payload
    });
    await this.write(record);
    return record;
  }

  async updateStep(
    runId: string,
    stepId: string,
    input: {
      status: RunSpecStepStateStatus;
      message?: string;
      output?: Record<string, unknown>;
      attempts?: number;
    }
  ): Promise<RunSpecRecord | null> {
    const record = await this.get(runId);
    if (!record) {
      return null;
    }
    const existing = record.stepStates[stepId];
    if (!existing) {
      return record;
    }

    const at = nowIso();
    const next: RunSpecStepState = {
      ...existing,
      status: input.status,
      attempts: input.attempts ?? existing.attempts,
      message: input.message ?? existing.message,
      output: input.output ?? existing.output
    };
    if (input.status === "running" && !next.startedAt) {
      next.startedAt = at;
    }
    if (input.status === "completed" || input.status === "failed" || input.status === "cancelled" || input.status === "skipped") {
      next.endedAt = at;
      if (!next.startedAt) {
        next.startedAt = at;
      }
    }
    record.stepStates[stepId] = next;
    record.updatedAt = at;
    record.events.push({
      seq: record.events.length + 1,
      at,
      type: "step_status",
      stepId,
      message: input.message,
      payload: {
        status: input.status
      }
    });
    await this.write(record);
    return record;
  }

  async grantStepApproval(runId: string, stepId: string): Promise<RunSpecRecord | null> {
    const record = await this.get(runId);
    if (!record) {
      return null;
    }
    if (!record.approvedStepIds.includes(stepId)) {
      record.approvedStepIds.push(stepId);
    }
    const step = record.stepStates[stepId];
    if (step && (step.status === "approval_required" || step.status === "pending")) {
      step.status = "approved";
      step.message = "Approved by user";
    }
    record.updatedAt = nowIso();
    record.events.push({
      seq: record.events.length + 1,
      at: record.updatedAt,
      type: "approval_granted",
      stepId,
      message: "Step approved"
    });
    await this.write(record);
    return record;
  }

  private filePath(runId: string): string {
    return path.join(this.dirPath, `${runId}.json`);
  }

  private async write(record: RunSpecRecord): Promise<void> {
    await this.ensureReady();
    const destination = this.filePath(record.runId);
    const temp = `${destination}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(temp, destination);
  }
}

function uniqueStepIds(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function createInitialStepStates(spec: RunSpecV1, approvedStepIds: string[]): Record<string, RunSpecStepState> {
  const approved = new Set(approvedStepIds);
  const states: Record<string, RunSpecStepState> = {};
  for (const step of spec.steps) {
    const requiresApproval = step.approval?.required === true;
    let status: RunSpecStepStateStatus = "pending";
    if (requiresApproval && approved.has(step.id)) {
      status = "approved";
    } else if (requiresApproval) {
      status = "approval_required";
    }
    states[step.id] = {
      stepId: step.id,
      status,
      attempts: 0
    };
  }
  return states;
}
