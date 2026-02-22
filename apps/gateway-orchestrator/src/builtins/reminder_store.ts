import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ReminderRecord = {
  id: string;
  sessionId: string;
  text: string;
  remindAt: string;
  status: "pending" | "triggered" | "cancelled";
  createdAt: string;
  triggeredAt?: string;
};

type ReminderState = { reminders: ReminderRecord[] };

export class ReminderStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "reminders.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ reminders: [] }, null, 2), "utf8");
    }
  }

  async add(sessionId: string, text: string, remindAt: string): Promise<ReminderRecord> {
    const state = await this.read();
    const record: ReminderRecord = {
      id: randomUUID(),
      sessionId,
      text,
      remindAt,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    state.reminders.push(record);
    await this.write(state);
    return record;
  }

  async listBySession(sessionId: string): Promise<ReminderRecord[]> {
    const state = await this.read();
    return state.reminders.filter((item) => item.sessionId === sessionId && item.status === "pending");
  }

  async listDue(now = new Date()): Promise<ReminderRecord[]> {
    const state = await this.read();
    return state.reminders.filter((item) => item.status === "pending" && new Date(item.remindAt) <= now);
  }

  async markTriggered(id: string): Promise<void> {
    const state = await this.read();
    const target = state.reminders.find((item) => item.id === id);
    if (!target) {
      return;
    }

    target.status = "triggered";
    target.triggeredAt = new Date().toISOString();
    await this.write(state);
  }

  private async read(): Promise<ReminderState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as ReminderState;
    if (!parsed || !Array.isArray(parsed.reminders)) {
      return { reminders: [] };
    }
    return parsed;
  }

  private async write(state: ReminderState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
