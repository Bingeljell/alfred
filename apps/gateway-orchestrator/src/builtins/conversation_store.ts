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

export type ConversationQuery = {
  sessionId?: string;
  limit?: number;
  sources?: ConversationSource[];
  channels?: ConversationChannel[];
  kinds?: ConversationKind[];
  directions?: ConversationDirection[];
  text?: string;
  since?: string;
};

export class ConversationStore {
  private readonly filePath: string;
  private readonly maxEvents: number;
  private readonly retentionMs: number;
  private readonly dedupeWindowMs: number;
  private readonly listeners = new Set<(event: ConversationRecord) => void>();

  constructor(
    stateDir: string,
    options?:
      | number
      | {
          maxEvents?: number;
          retentionDays?: number;
          dedupeWindowMs?: number;
        }
  ) {
    this.filePath = path.join(stateDir, "builtins", "conversations.json");
    if (typeof options === "number") {
      this.maxEvents = options;
      this.retentionMs = 14 * 24 * 60 * 60 * 1000;
      this.dedupeWindowMs = 2500;
      return;
    }

    this.maxEvents = options?.maxEvents ?? 5000;
    const retentionDays = Math.max(1, options?.retentionDays ?? 14);
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    this.dedupeWindowMs = Math.max(0, options?.dedupeWindowMs ?? 2500);
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
    const { state, changed } = await this.readAndPrune();
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

    if (this.isNoisyDuplicate(state.events, record)) {
      const latest = state.events[state.events.length - 1];
      if (changed) {
        await this.write(state);
      }
      return latest;
    }

    state.events.push(record);
    if (state.events.length > this.maxEvents) {
      state.events = state.events.slice(state.events.length - this.maxEvents);
    }
    await this.write(state);
    this.emit(record);
    return record;
  }

  async listBySession(sessionId: string, limit = 100): Promise<ConversationRecord[]> {
    return this.query({
      sessionId,
      limit
    });
  }

  async listRecent(limit = 100): Promise<ConversationRecord[]> {
    return this.query({
      limit
    });
  }

  async query(query: ConversationQuery): Promise<ConversationRecord[]> {
    const bounded = Number.isFinite(query.limit ?? 100) ? Math.max(1, Math.min(500, Math.floor(query.limit ?? 100))) : 100;
    const { state, changed } = await this.readAndPrune();
    if (changed) {
      await this.write(state);
    }

    const sourceSet = query.sources && query.sources.length > 0 ? new Set(query.sources) : null;
    const channelSet = query.channels && query.channels.length > 0 ? new Set(query.channels) : null;
    const kindSet = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const directionSet = query.directions && query.directions.length > 0 ? new Set(query.directions) : null;
    const textFilter = query.text?.trim().toLowerCase() ?? "";
    const sinceUnixMs = query.since ? Date.parse(query.since) : Number.NaN;
    const sinceActive = Number.isFinite(sinceUnixMs);

    const filtered = state.events.filter((event) => {
      if (query.sessionId && event.sessionId !== query.sessionId) {
        return false;
      }
      if (sourceSet && !sourceSet.has(event.source)) {
        return false;
      }
      if (channelSet && !channelSet.has(event.channel)) {
        return false;
      }
      if (kindSet && !kindSet.has(event.kind)) {
        return false;
      }
      if (directionSet && !directionSet.has(event.direction)) {
        return false;
      }
      if (textFilter && !event.text.toLowerCase().includes(textFilter)) {
        return false;
      }
      if (sinceActive) {
        const eventUnixMs = Date.parse(event.createdAt);
        if (Number.isFinite(eventUnixMs) && eventUnixMs < sinceUnixMs) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length <= bounded) {
      return filtered;
    }
    return filtered.slice(filtered.length - bounded);
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

  private async readAndPrune(): Promise<{ state: ConversationState; changed: boolean }> {
    const state = await this.read();
    const retained = this.pruneEvents(state.events);
    const changed = retained.length !== state.events.length;
    if (!changed) {
      return { state, changed: false };
    }
    return {
      state: { events: retained },
      changed: true
    };
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

  private pruneEvents(events: ConversationRecord[]): ConversationRecord[] {
    if (events.length === 0) {
      return events;
    }

    const cutoff = Date.now() - this.retentionMs;
    const retained = events.filter((event) => {
      const createdAtUnixMs = Date.parse(event.createdAt);
      if (!Number.isFinite(createdAtUnixMs)) {
        return true;
      }
      return createdAtUnixMs >= cutoff;
    });

    if (retained.length <= this.maxEvents) {
      return retained;
    }
    return retained.slice(retained.length - this.maxEvents);
  }

  private isNoisyDuplicate(events: ConversationRecord[], incoming: ConversationRecord): boolean {
    if (this.dedupeWindowMs <= 0 || events.length === 0) {
      return false;
    }

    const latest = events[events.length - 1];
    const latestUnixMs = Date.parse(latest.createdAt);
    const incomingUnixMs = Date.parse(incoming.createdAt);
    if (!Number.isFinite(latestUnixMs) || !Number.isFinite(incomingUnixMs)) {
      return false;
    }

    if (incomingUnixMs - latestUnixMs > this.dedupeWindowMs) {
      return false;
    }

    return (
      latest.sessionId === incoming.sessionId &&
      latest.direction === incoming.direction &&
      latest.source === incoming.source &&
      latest.channel === incoming.channel &&
      latest.kind === incoming.kind &&
      latest.text === incoming.text
    );
  }
}
