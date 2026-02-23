import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ConversationDirection = "inbound" | "outbound" | "system";
export type ConversationSource = "gateway" | "whatsapp" | "auth" | "memory" | "worker" | "system";
export type ConversationChannel = "direct" | "baileys" | "api" | "internal";
export type ConversationKind = "chat" | "command" | "job" | "status" | "error" | "dedupe";

export type ConversationRecord = {
  id: string;
  sessionId: string;
  direction: ConversationDirection;
  text: string;
  source: ConversationSource;
  channel: ConversationChannel;
  kind: ConversationKind;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type ConversationState = {
  events: ConversationRecord[];
};

export class ConversationStore {
  private readonly filePath: string;
  private readonly maxEvents: number;
  private readonly listeners = new Set<(event: ConversationRecord) => void>();

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

  async add(
    sessionId: string,
    direction: ConversationDirection,
    text: string,
    options?: {
      source?: ConversationSource;
      channel?: ConversationChannel;
      kind?: ConversationKind;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ConversationRecord> {
    const state = await this.read();
    const record: ConversationRecord = {
      id: randomUUID(),
      sessionId,
      direction,
      text,
      source: options?.source ?? "gateway",
      channel: options?.channel ?? "direct",
      kind: options?.kind ?? "chat",
      metadata: options?.metadata,
      createdAt: new Date().toISOString()
    };

    state.events.push(record);
    if (state.events.length > this.maxEvents) {
      state.events = state.events.slice(state.events.length - this.maxEvents);
    }
    await this.write(state);
    this.emit(record);
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

  async listRecent(limit = 100): Promise<ConversationRecord[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const state = await this.read();
    if (state.events.length <= bounded) {
      return state.events;
    }
    return state.events.slice(state.events.length - bounded);
  }

  subscribe(listener: (event: ConversationRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async read(): Promise<ConversationState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConversationState>;
    if (!parsed || !Array.isArray(parsed.events)) {
      return { events: [] };
    }

    const normalized: ConversationRecord[] = parsed.events
      .filter((item) => !!item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : randomUUID(),
        sessionId: typeof item.sessionId === "string" && item.sessionId ? item.sessionId : "system",
        direction:
          item.direction === "inbound" || item.direction === "outbound" || item.direction === "system"
            ? item.direction
            : "system",
        text: typeof item.text === "string" ? item.text : "",
        source:
          item.source === "gateway" ||
          item.source === "whatsapp" ||
          item.source === "auth" ||
          item.source === "memory" ||
          item.source === "worker" ||
          item.source === "system"
            ? item.source
            : "system",
        channel:
          item.channel === "direct" || item.channel === "baileys" || item.channel === "api" || item.channel === "internal"
            ? item.channel
            : "internal",
        kind:
          item.kind === "chat" ||
          item.kind === "command" ||
          item.kind === "job" ||
          item.kind === "status" ||
          item.kind === "error" ||
          item.kind === "dedupe"
            ? item.kind
            : "status",
        metadata:
          item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
            ? (item.metadata as Record<string, unknown>)
            : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
      }));

    return { events: normalized };
  }

  private async write(state: ConversationState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }

  private emit(event: ConversationRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore observer errors
      }
    }
  }
}
