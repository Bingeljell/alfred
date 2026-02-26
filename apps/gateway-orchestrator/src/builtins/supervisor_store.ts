import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type SupervisorChildStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type SupervisorStatus = "running" | "completed" | "failed" | "cancelled";

export type SupervisorChild = {
  jobId: string;
  provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata";
  status: SupervisorChildStatus;
  createdAt: string;
  updatedAt: string;
  maxRetries: number;
  timeBudgetMs: number;
  tokenBudget: number;
  retriesUsed: number;
  lastSummary?: string;
  lastError?: string;
};

export type SupervisorRun = {
  id: string;
  sessionId: string;
  parentRunId?: string;
  strategy: "web_fanout";
  query: string;
  status: SupervisorStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  children: SupervisorChild[];
};

type PersistedState = {
  runs: SupervisorRun[];
};

export class SupervisorStore {
  private readonly filePath: string;

  constructor(private readonly stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "supervisors.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ runs: [] }, null, 2), "utf8");
    }
  }

  async createWebFanout(input: {
    sessionId: string;
    query: string;
    parentRunId?: string;
    children: Array<{
      provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata";
      maxRetries: number;
      timeBudgetMs: number;
      tokenBudget: number;
    }>;
  }): Promise<SupervisorRun> {
    const state = await this.read();
    const now = new Date().toISOString();
    const run: SupervisorRun = {
      id: randomUUID(),
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      strategy: "web_fanout",
      query: input.query,
      status: "running",
      createdAt: now,
      updatedAt: now,
      children: input.children.map((child) => ({
        jobId: "",
        provider: child.provider,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        maxRetries: Math.max(0, Math.min(5, child.maxRetries)),
        timeBudgetMs: Math.max(5_000, Math.min(10 * 60 * 1000, child.timeBudgetMs)),
        tokenBudget: Math.max(128, Math.min(50_000, child.tokenBudget)),
        retriesUsed: 0
      }))
    };
    state.runs.push(run);
    await this.write(state);
    return run;
  }

  async assignChildJob(
    supervisorId: string,
    provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata",
    jobId: string
  ): Promise<SupervisorRun | null> {
    const state = await this.read();
    const run = state.runs.find((item) => item.id === supervisorId);
    if (!run) {
      return null;
    }
    const child = run.children.find((item) => item.provider === provider && !item.jobId);
    if (!child) {
      return null;
    }
    const now = new Date().toISOString();
    child.jobId = jobId;
    child.updatedAt = now;
    run.updatedAt = now;
    await this.write(state);
    return run;
  }

  async updateChildByJob(
    jobId: string,
    patch: {
      status: SupervisorChildStatus;
      summary?: string;
      error?: string;
      retriesUsed?: number;
    }
  ): Promise<{ run: SupervisorRun; child: SupervisorChild; transitionedToTerminal: boolean } | null> {
    const state = await this.read();
    const now = new Date().toISOString();
    for (const run of state.runs) {
      const child = run.children.find((item) => item.jobId === jobId);
      if (!child) {
        continue;
      }
      child.status = patch.status;
      child.updatedAt = now;
      if (patch.summary) {
        child.lastSummary = patch.summary;
      }
      if (patch.error) {
        child.lastError = patch.error;
      }
      if (typeof patch.retriesUsed === "number" && Number.isFinite(patch.retriesUsed)) {
        child.retriesUsed = Math.max(0, Math.min(child.maxRetries, Math.floor(patch.retriesUsed)));
      }

      const previousRunStatus = run.status;
      this.refreshRunStatus(run, now);
      await this.write(state);
      return {
        run,
        child,
        transitionedToTerminal: previousRunStatus === "running" && run.status !== "running"
      };
    }
    return null;
  }

  async get(supervisorId: string): Promise<SupervisorRun | null> {
    const state = await this.read();
    return state.runs.find((item) => item.id === supervisorId) ?? null;
  }

  async list(query?: { sessionId?: string; limit?: number }): Promise<SupervisorRun[]> {
    const state = await this.read();
    const bounded = Number.isFinite(query?.limit) ? Math.max(1, Math.min(200, Math.floor(query?.limit ?? 50))) : 50;
    return [...state.runs]
      .filter((item) => (query?.sessionId ? item.sessionId === query.sessionId : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, bounded);
  }

  summarize(run: SupervisorRun): string {
    const counts = run.children.reduce(
      (acc, child) => {
        acc[child.status] += 1;
        return acc;
      },
      {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0
      }
    );

    const parts = [
      `Supervisor ${run.id} (${run.strategy})`,
      `status=${run.status}`,
      `succeeded=${counts.succeeded}`,
      `failed=${counts.failed}`,
      `cancelled=${counts.cancelled}`,
      `running=${counts.running}`,
      `queued=${counts.queued}`
    ];
    return parts.join(" | ");
  }

  private refreshRunStatus(run: SupervisorRun, now: string): void {
    run.updatedAt = now;
    const total = run.children.length;
    const terminal = run.children.filter((child) => child.status === "succeeded" || child.status === "failed" || child.status === "cancelled");
    const hasFailed = run.children.some((child) => child.status === "failed");
    const hasCancelled = run.children.some((child) => child.status === "cancelled");
    if (terminal.length < total) {
      run.status = "running";
      run.completedAt = undefined;
      return;
    }
    if (hasFailed) {
      run.status = "failed";
    } else if (hasCancelled) {
      run.status = "cancelled";
    } else {
      run.status = "completed";
    }
    run.completedAt = now;
  }

  private async read(): Promise<PersistedState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || !Array.isArray(parsed.runs)) {
      return { runs: [] };
    }
    return {
      runs: parsed.runs.filter((item) => item && typeof item === "object") as SupervisorRun[]
    };
  }

  private async write(state: PersistedState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
