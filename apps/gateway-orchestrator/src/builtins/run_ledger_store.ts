import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type RunQueueMode = "steer" | "collect" | "followup";
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "blocked";
export type RunPhase =
  | "normalize"
  | "session"
  | "directives"
  | "plan"
  | "policy"
  | "route"
  | "persist"
  | "dispatch"
  | "completed"
  | "failed"
  | "cancelled";
export type RunEventType =
  | "started"
  | "phase"
  | "queued"
  | "progress"
  | "tool_event"
  | "partial"
  | "completed"
  | "failed"
  | "cancelled"
  | "note";

export type RunSpec = {
  version: number;
  runId: string;
  sessionKey: string;
  idempotencyKey: string;
  model?: string;
  provider?: string;
  toolPolicySnapshot: Record<string, unknown>;
  skillsSnapshot: {
    hash: string;
    content: string[];
  };
  memorySnapshot: {
    query?: string;
    snippets: Array<{
      source: string;
      hash: string;
      class?: "fact" | "preference" | "todo" | "decision";
    }>;
  };
  createdAt: string;
};

export type RunEvent = {
  runId: string;
  seq: number;
  at: string;
  type: RunEventType;
  phase?: RunPhase;
  message?: string;
  payload?: Record<string, unknown>;
};

export type RunRecord = {
  runId: string;
  parentRunId?: string;
  sessionKey: string;
  queueMode: RunQueueMode;
  status: RunStatus;
  currentPhase: RunPhase;
  spec: RunSpec;
  events: RunEvent[];
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  failureReason?: string;
};

type PersistedState = {
  runs: RunRecord[];
  activeBySession: Record<string, string>;
};

const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled", "blocked"]);

export class RunLedgerStore {
  private readonly filePath: string;
  private readonly maxRuns: number;
  private readonly retentionMs: number;

  constructor(
    stateDir: string,
    options?: {
      maxRuns?: number;
      retentionDays?: number;
    }
  ) {
    this.filePath = path.join(stateDir, "builtins", "runs.json");
    this.maxRuns = Math.max(100, options?.maxRuns ?? 6000);
    const retentionDays = Math.max(1, options?.retentionDays ?? 21);
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ runs: [], activeBySession: {} }, null, 2), "utf8");
    }
  }

  async startRun(input: {
    sessionKey: string;
    queueMode?: RunQueueMode;
    idempotencyKey?: string;
    parentRunId?: string;
    model?: string;
    provider?: string;
    toolPolicySnapshot?: Record<string, unknown>;
    skillsSnapshot?: { hash?: string; content?: string[] };
    memorySnapshot?: {
      query?: string;
      snippets?: Array<{ source: string; hash: string; class?: "fact" | "preference" | "todo" | "decision" }>;
    };
  }): Promise<{
    acquired: boolean;
    run: RunRecord;
    activeRunId?: string;
    reused: boolean;
  }> {
    const state = await this.read();
    this.prune(state);
    const now = new Date().toISOString();
    const sessionKey = input.sessionKey.trim();
    const queueMode = input.queueMode ?? "steer";
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

    const existing = [...state.runs]
      .reverse()
      .find((run) => run.sessionKey === sessionKey && run.spec.idempotencyKey === idempotencyKey);
    if (existing) {
      await this.write(state);
      return {
        acquired: !this.isActiveStatus(existing.status),
        run: existing,
        activeRunId: state.activeBySession[sessionKey],
        reused: true
      };
    }

    const activeRunId = state.activeBySession[sessionKey];
    const activeRun = activeRunId ? state.runs.find((run) => run.runId === activeRunId) : undefined;
    if (activeRun && this.isActiveStatus(activeRun.status)) {
      const blockedRun = this.buildRun({
        sessionKey,
        queueMode,
        idempotencyKey,
        now,
        parentRunId: input.parentRunId,
        model: input.model,
        provider: input.provider,
        toolPolicySnapshot: input.toolPolicySnapshot,
        skillsSnapshot: input.skillsSnapshot,
        memorySnapshot: input.memorySnapshot
      });
      blockedRun.status = "blocked";
      blockedRun.currentPhase = "dispatch";
      blockedRun.endedAt = now;
      blockedRun.failureReason = `session_busy:${activeRun.runId}`;
      blockedRun.events.push({
        runId: blockedRun.runId,
        seq: 2,
        at: now,
        type: "failed",
        phase: "dispatch",
        message: `Session is busy with run ${activeRun.runId}.`,
        payload: { activeRunId: activeRun.runId }
      });
      state.runs.push(blockedRun);
      this.trim(state);
      await this.write(state);
      return {
        acquired: false,
        run: blockedRun,
        activeRunId: activeRun.runId,
        reused: false
      };
    }

    const run = this.buildRun({
      sessionKey,
      queueMode,
      idempotencyKey,
      now,
      parentRunId: input.parentRunId,
      model: input.model,
      provider: input.provider,
      toolPolicySnapshot: input.toolPolicySnapshot,
      skillsSnapshot: input.skillsSnapshot,
      memorySnapshot: input.memorySnapshot
    });
    state.runs.push(run);
    state.activeBySession[sessionKey] = run.runId;
    this.trim(state);
    await this.write(state);
    return {
      acquired: true,
      run,
      reused: false
    };
  }

  async transitionPhase(runId: string, phase: RunPhase, message?: string, payload?: Record<string, unknown>): Promise<RunRecord | null> {
    return this.appendEvent(runId, "phase", phase, message, payload);
  }

  async appendEvent(
    runId: string,
    type: RunEventType,
    phase?: RunPhase,
    message?: string,
    payload?: Record<string, unknown>
  ): Promise<RunRecord | null> {
    const state = await this.read();
    this.prune(state);
    const run = state.runs.find((item) => item.runId === runId);
    if (!run) {
      await this.write(state);
      return null;
    }

    const at = new Date().toISOString();
    const seq = run.events.length + 1;
    run.events.push({
      runId,
      seq,
      at,
      type,
      phase,
      message,
      payload
    });
    if (phase) {
      run.currentPhase = phase;
    }
    run.updatedAt = at;
    this.trim(state);
    await this.write(state);
    return run;
  }

  async completeRun(runId: string, status: Exclude<RunStatus, "running" | "blocked">, message?: string): Promise<RunRecord | null> {
    const state = await this.read();
    this.prune(state);
    const run = state.runs.find((item) => item.runId === runId);
    if (!run) {
      await this.write(state);
      return null;
    }

    const at = new Date().toISOString();
    run.status = status;
    run.updatedAt = at;
    run.endedAt = at;
    run.currentPhase = status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled";
    if (status === "failed" && message) {
      run.failureReason = message;
    }

    const mappedType: RunEventType = status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled";
    run.events.push({
      runId,
      seq: run.events.length + 1,
      at,
      type: mappedType,
      phase: run.currentPhase,
      message
    });

    if (state.activeBySession[run.sessionKey] === run.runId) {
      delete state.activeBySession[run.sessionKey];
    }

    this.trim(state);
    await this.write(state);
    return run;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const state = await this.read();
    this.prune(state);
    await this.write(state);
    return state.runs.find((run) => run.runId === runId) ?? null;
  }

  async listRuns(query?: { sessionKey?: string; limit?: number }): Promise<RunRecord[]> {
    const state = await this.read();
    this.prune(state);
    await this.write(state);
    const boundedLimit = Number.isFinite(query?.limit) ? Math.max(1, Math.min(500, Math.floor(query?.limit ?? 50))) : 50;
    const rows = [...state.runs]
      .filter((run) => (query?.sessionKey ? run.sessionKey === query.sessionKey : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return rows.slice(0, boundedLimit);
  }

  private buildRun(input: {
    sessionKey: string;
    queueMode: RunQueueMode;
    idempotencyKey: string;
    now: string;
    parentRunId?: string;
    model?: string;
    provider?: string;
    toolPolicySnapshot?: Record<string, unknown>;
    skillsSnapshot?: { hash?: string; content?: string[] };
    memorySnapshot?: {
      query?: string;
      snippets?: Array<{ source: string; hash: string; class?: "fact" | "preference" | "todo" | "decision" }>;
    };
  }): RunRecord {
    const runId = randomUUID();
    const started: RunRecord = {
      runId,
      parentRunId: input.parentRunId,
      sessionKey: input.sessionKey,
      queueMode: input.queueMode,
      status: "running",
      currentPhase: "normalize",
      spec: {
        version: 1,
        runId,
        sessionKey: input.sessionKey,
        idempotencyKey: input.idempotencyKey,
        model: input.model,
        provider: input.provider,
        toolPolicySnapshot: input.toolPolicySnapshot ?? {},
        skillsSnapshot: {
          hash: input.skillsSnapshot?.hash ?? "none",
          content: input.skillsSnapshot?.content ?? []
        },
        memorySnapshot: {
          query: input.memorySnapshot?.query,
          snippets: input.memorySnapshot?.snippets ?? []
        },
        createdAt: input.now
      },
      events: [
        {
          runId,
          seq: 1,
          at: input.now,
          type: "started",
          phase: "normalize",
          message: "Run started"
        }
      ],
      createdAt: input.now,
      updatedAt: input.now,
      startedAt: input.now
    };
    return started;
  }

  private isActiveStatus(status: RunStatus): boolean {
    return !TERMINAL_STATUSES.has(status);
  }

  private async read(): Promise<PersistedState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.runs) || !parsed.activeBySession || typeof parsed.activeBySession !== "object") {
      return { runs: [], activeBySession: {} };
    }
    return {
      runs: parsed.runs.filter((run) => run && typeof run === "object") as RunRecord[],
      activeBySession: { ...(parsed.activeBySession as Record<string, string>) }
    };
  }

  private async write(state: PersistedState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }

  private trim(state: PersistedState): void {
    this.prune(state);
    if (state.runs.length <= this.maxRuns) {
      return;
    }
    state.runs = state.runs.slice(state.runs.length - this.maxRuns);
    const activeIds = new Set(state.runs.map((run) => run.runId));
    for (const [sessionKey, runId] of Object.entries(state.activeBySession)) {
      if (!activeIds.has(runId)) {
        delete state.activeBySession[sessionKey];
      }
    }
  }

  private prune(state: PersistedState): void {
    const cutoff = Date.now() - this.retentionMs;
    const retained = state.runs.filter((run) => {
      const created = Date.parse(run.createdAt);
      if (!Number.isFinite(created)) {
        return true;
      }
      if (created >= cutoff) {
        return true;
      }
      return this.isActiveStatus(run.status);
    });
    state.runs = retained;
    const known = new Set(retained.map((run) => run.runId));
    for (const [sessionKey, runId] of Object.entries(state.activeBySession)) {
      if (!known.has(runId)) {
        delete state.activeBySession[sessionKey];
      }
    }
  }
}

