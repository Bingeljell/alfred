import fs from "node:fs/promises";
import path from "node:path";

type ThreadState = {
  sessionThreads: Record<string, string>;
};

export class CodexThreadStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "codex", "session_threads.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ sessionThreads: {} }, null, 2), "utf8");
    }
  }

  async get(sessionId: string): Promise<string | null> {
    const state = await this.read();
    return state.sessionThreads[sessionId] ?? null;
  }

  async put(sessionId: string, threadId: string): Promise<void> {
    const state = await this.read();
    state.sessionThreads[sessionId] = threadId;
    await this.write(state);
  }

  async delete(sessionId: string): Promise<void> {
    const state = await this.read();
    delete state.sessionThreads[sessionId];
    await this.write(state);
  }

  private async read(): Promise<ThreadState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ThreadState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessionThreads !== "object" || parsed.sessionThreads === null) {
      return { sessionThreads: {} };
    }
    return {
      sessionThreads: parsed.sessionThreads as Record<string, string>
    };
  }

  private async write(state: ThreadState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
