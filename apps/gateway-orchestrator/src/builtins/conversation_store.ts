import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ConversationDirection = "inbound" | "outbound";

export type ConversationRecord = {
  id: string;
  sessionId: string;
  direction: ConversationDirection;
  text: string;
  createdAt: string;
};

type ConversationState = {
  events: ConversationRecord[];
};

export class ConversationStore {
  private readonly filePath: string;
  private readonly maxEvents: number;

  constructor(stateDir: string, maxEvents = 5000) {
    this.filePath = path.join(stateDir, "builtins", "conversations.json");
    this.maxEvents = maxEvents;
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ events: [] }, null, 2), "utf8");
    }
  }

  async add(sessionId: string, direction: ConversationDirection, text: string): Promise<ConversationRecord> {
    const state = await this.read();
    const record: ConversationRecord = {
      id: randomUUID(),
      sessionId,
      direction,
      text,
      createdAt: new Date().toISOString()
    };

    state.events.push(record);
    if (state.events.length > this.maxEvents) {
      state.events = state.events.slice(state.events.length - this.maxEvents);
    }
    await this.write(state);
    return record;
  }

  async listBySession(sessionId: string, limit = 100): Promise<ConversationRecord[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const state = await this.read();
    const events = state.events.filter((item) => item.sessionId === sessionId);
    if (events.length <= bounded) {
      return events;
    }
    return events.slice(events.length - bounded);
  }

  private async read(): Promise<ConversationState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConversationState>;
    if (!parsed || !Array.isArray(parsed.events)) {
      return { events: [] };
    }
    return { events: parsed.events };
  }

  private async write(state: ConversationState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
