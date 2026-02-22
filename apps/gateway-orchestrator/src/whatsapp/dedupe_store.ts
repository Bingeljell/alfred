import fs from "node:fs/promises";
import path from "node:path";

type DedupeMap = Record<string, number>;

export class MessageDedupeStore {
  private readonly filePath: string;

  constructor(stateDir: string, private readonly ttlMs = 24 * 60 * 60 * 1000) {
    this.filePath = path.join(stateDir, "dedupe", "message_dedupe.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({}, null, 2), "utf8");
    }
  }

  async isDuplicateAndMark(key: string, now = Date.now()): Promise<boolean> {
    await this.ensureReady();
    const state = await this.readMap();

    this.pruneExpired(state, now);

    if (state[key] && state[key] > now) {
      await this.writeMap(state);
      return true;
    }

    state[key] = now + this.ttlMs;
    await this.writeMap(state);
    return false;
  }

  private pruneExpired(state: DedupeMap, now: number): void {
    for (const [key, expiresAt] of Object.entries(state)) {
      if (expiresAt <= now) {
        delete state[key];
      }
    }
  }

  private async readMap(): Promise<DedupeMap> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DedupeMap;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeMap(state: DedupeMap): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
