import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ApprovalRecord = {
  token: string;
  sessionId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
};

type ApprovalState = { approvals: ApprovalRecord[] };

export class ApprovalStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "approvals.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ approvals: [] }, null, 2), "utf8");
    }
  }

  async create(sessionId: string, action: string, payload: Record<string, unknown>, ttlMs = 10 * 60 * 1000): Promise<ApprovalRecord> {
    const state = await this.read();
    const createdAt = new Date();
    const record: ApprovalRecord = {
      token: randomUUID().slice(0, 8),
      sessionId,
      action,
      payload,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString()
    };

    state.approvals.push(record);
    await this.write(state);
    return record;
  }

  async consume(sessionId: string, token: string): Promise<ApprovalRecord | null> {
    const state = await this.read();
    const idx = state.approvals.findIndex((item) => item.token === token && item.sessionId === sessionId);

    if (idx < 0) {
      return null;
    }

    const record = state.approvals[idx];
    state.approvals.splice(idx, 1);
    await this.write(state);

    if (new Date(record.expiresAt) < new Date()) {
      return null;
    }

    return record;
  }

  private async read(): Promise<ApprovalState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as ApprovalState;
    if (!parsed || !Array.isArray(parsed.approvals)) {
      return { approvals: [] };
    }
    return parsed;
  }

  private async write(state: ApprovalState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
