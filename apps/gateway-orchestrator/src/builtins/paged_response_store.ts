import fs from "node:fs/promises";
import path from "node:path";

type SessionPagedResponse = {
  pages: string[];
  nextIndex: number;
  updatedAt: string;
};

type PagedResponseState = {
  sessions: Record<string, SessionPagedResponse>;
};

export class PagedResponseStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "builtins", "paged_responses.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ sessions: {} }, null, 2), "utf8");
    }
  }

  async setPages(sessionId: string, pages: string[]): Promise<void> {
    await this.ensureReady();
    const normalized = pages.map((item) => item.trim()).filter((item) => item.length > 0);
    const state = await this.read();
    if (normalized.length === 0) {
      delete state.sessions[sessionId];
      await this.write(state);
      return;
    }

    state.sessions[sessionId] = {
      pages: normalized,
      nextIndex: 0,
      updatedAt: new Date().toISOString()
    };
    await this.write(state);
  }

  async popNext(sessionId: string): Promise<{ page: string; remaining: number } | null> {
    await this.ensureReady();
    const state = await this.read();
    const entry = state.sessions[sessionId];
    if (!entry || entry.nextIndex >= entry.pages.length) {
      return null;
    }

    const index = entry.nextIndex;
    const page = entry.pages[index] ?? "";
    entry.nextIndex += 1;
    entry.updatedAt = new Date().toISOString();
    const remaining = Math.max(0, entry.pages.length - entry.nextIndex);
    if (remaining === 0) {
      delete state.sessions[sessionId];
    }
    await this.write(state);

    return {
      page,
      remaining
    };
  }

  async clear(sessionId: string): Promise<void> {
    await this.ensureReady();
    const state = await this.read();
    delete state.sessions[sessionId];
    await this.write(state);
  }

  private async read(): Promise<PagedResponseState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PagedResponseState>;
    if (!parsed || typeof parsed !== "object") {
      return { sessions: {} };
    }
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return { sessions: {} };
    }
    return {
      sessions: parsed.sessions as Record<string, SessionPagedResponse>
    };
  }

  private async write(state: PagedResponseState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
