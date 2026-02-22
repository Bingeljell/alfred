import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type TaskRecord = {
  id: string;
  sessionId: string;
  text: string;
  status: "open" | "done";
  createdAt: string;
  completedAt?: string;
};

type TaskState = { tasks: TaskRecord[] };

export class TaskStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "tasks.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ tasks: [] }, null, 2), "utf8");
    }
  }

  async add(sessionId: string, text: string): Promise<TaskRecord> {
    const state = await this.read();
    const record: TaskRecord = {
      id: randomUUID(),
      sessionId,
      text,
      status: "open",
      createdAt: new Date().toISOString()
    };

    state.tasks.push(record);
    await this.write(state);
    return record;
  }

  async listOpen(sessionId: string): Promise<TaskRecord[]> {
    const state = await this.read();
    return state.tasks.filter((item) => item.sessionId === sessionId && item.status === "open");
  }

  async markDone(sessionId: string, taskId: string): Promise<TaskRecord | null> {
    const state = await this.read();
    const task = state.tasks.find((item) => item.id === taskId && item.sessionId === sessionId);
    if (!task) {
      return null;
    }

    task.status = "done";
    task.completedAt = new Date().toISOString();
    await this.write(state);
    return task;
  }

  private async read(): Promise<TaskState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as TaskState;
    if (!parsed || !Array.isArray(parsed.tasks)) {
      return { tasks: [] };
    }
    return parsed;
  }

  private async write(state: TaskState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
