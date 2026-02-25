import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type MemoryCheckpointClass = "fact" | "preference" | "todo" | "decision";

export type MemoryCheckpointConfig = {
  enabled: boolean;
  maxEntriesPerDay: number;
  dedupeWindowMs: number;
  maxSummaryChars: number;
  syncOnWrite: boolean;
};

export type MemoryCheckpointRecord = {
  id: string;
  dedupeKey: string;
  sessionId: string;
  class: MemoryCheckpointClass;
  source: string;
  summary: string;
  day: string;
  createdAt: string;
};

type PersistedState = {
  config: MemoryCheckpointConfig;
  records: MemoryCheckpointRecord[];
  runtime: {
    writeCount: number;
    skippedDuplicateCount: number;
    skippedDailyLimitCount: number;
    skippedDisabledCount: number;
    lastWriteAt?: string;
    lastSkipReason?: string;
  };
};

type Dependencies = {
  memoryService: {
    appendMemoryNote: (text: string, date?: string) => Promise<{ path: string }>;
    syncMemory: (reason?: string) => Promise<void>;
  };
  defaultConfig?: Partial<MemoryCheckpointConfig>;
};

type CheckpointInput = {
  sessionId: string;
  class: MemoryCheckpointClass;
  source: string;
  summary: string;
  details?: string;
  dedupeKey?: string;
  day?: string;
};

type CheckpointResult =
  | { written: true; reason: "written"; day: string }
  | { written: false; reason: "disabled" | "duplicate" | "daily_limit" | "invalid" };

const DEFAULT_CONFIG: MemoryCheckpointConfig = {
  enabled: true,
  maxEntriesPerDay: 48,
  dedupeWindowMs: 24 * 60 * 60 * 1000,
  maxSummaryChars: 320,
  syncOnWrite: false
};

export class MemoryCheckpointService {
  private readonly filePath: string;
  private readonly memoryService: Dependencies["memoryService"];
  private readonly defaults: Partial<MemoryCheckpointConfig>;
  private state?: PersistedState;

  constructor(stateDir: string, deps: Dependencies) {
    this.filePath = path.join(stateDir, "builtins", "memory_checkpoints.json");
    this.memoryService = deps.memoryService;
    this.defaults = deps.defaultConfig ?? {};
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.state) {
      return;
    }

    const loaded = await this.read();
    if (loaded) {
      this.state = {
        config: normalizeConfig(loaded.config, this.defaults),
        records: normalizeRecords(loaded.records),
        runtime: normalizeRuntime(loaded.runtime)
      };
    } else {
      this.state = {
        config: normalizeConfig(undefined, this.defaults),
        records: [],
        runtime: normalizeRuntime(undefined)
      };
    }
    await this.persist();
  }

  async status(): Promise<{
    config: MemoryCheckpointConfig;
    runtime: PersistedState["runtime"];
    recent: MemoryCheckpointRecord[];
  }> {
    await this.ensureReady();
    const state = this.state!;
    return {
      config: state.config,
      runtime: state.runtime,
      recent: [...state.records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 10)
    };
  }

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
    await this.ensureReady();
    const state = this.state!;
    const config = state.config;

    if (!config.enabled) {
      state.runtime.skippedDisabledCount += 1;
      state.runtime.lastSkipReason = "disabled";
      await this.persist();
      return { written: false, reason: "disabled" };
    }

    const normalizedSessionId = input.sessionId.trim();
    const normalizedSource = input.source.trim();
    const normalizedSummary = normalizeSummary(input.summary, config.maxSummaryChars);
    const day = normalizeDay(input.day) ?? isoDay();
    if (!normalizedSessionId || !normalizedSource || !normalizedSummary || !day) {
      state.runtime.lastSkipReason = "invalid";
      await this.persist();
      return { written: false, reason: "invalid" };
    }

    const dedupeKey = (input.dedupeKey?.trim() || hashKey([normalizedSessionId, input.class, normalizedSource, normalizedSummary])).slice(
      0,
      80
    );
    const now = Date.now();
    const dedupeStart = now - config.dedupeWindowMs;
    state.records = state.records.filter((item) => Date.parse(item.createdAt) >= dedupeStart);

    const duplicate = state.records.some((item) => item.dedupeKey === dedupeKey);
    if (duplicate) {
      state.runtime.skippedDuplicateCount += 1;
      state.runtime.lastSkipReason = "duplicate";
      await this.persist();
      return { written: false, reason: "duplicate" };
    }

    const dayCount = state.records.filter((item) => item.day === day).length;
    if (dayCount >= config.maxEntriesPerDay) {
      state.runtime.skippedDailyLimitCount += 1;
      state.runtime.lastSkipReason = "daily_limit";
      await this.persist();
      return { written: false, reason: "daily_limit" };
    }

    const createdAt = new Date(now).toISOString();
    const details = normalizeDetails(input.details);
    const noteLines = [
      "[memory-checkpoint]",
      `class: ${input.class}`,
      `source: ${normalizedSource}`,
      `session: ${normalizedSessionId}`,
      `summary: ${normalizedSummary}`
    ];
    if (details) {
      noteLines.push(`details: ${details}`);
    }
    noteLines.push(`at: ${createdAt}`);

    await this.memoryService.appendMemoryNote(noteLines.join("\n"), day);
    if (config.syncOnWrite) {
      await this.memoryService.syncMemory("memory_checkpoint");
    }

    state.records.push({
      id: randomUUID(),
      dedupeKey,
      sessionId: normalizedSessionId,
      class: input.class,
      source: normalizedSource,
      summary: normalizedSummary,
      day,
      createdAt
    });
    state.runtime.writeCount += 1;
    state.runtime.lastWriteAt = createdAt;
    state.runtime.lastSkipReason = undefined;
    await this.persist();

    return { written: true, reason: "written", day };
  }

  private async read(): Promise<PersistedState | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as PersistedState;
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}

function normalizeConfig(
  config: Partial<MemoryCheckpointConfig> | undefined,
  defaults: Partial<MemoryCheckpointConfig>
): MemoryCheckpointConfig {
  return {
    enabled: config?.enabled ?? defaults.enabled ?? DEFAULT_CONFIG.enabled,
    maxEntriesPerDay: clampInt(
      config?.maxEntriesPerDay ?? defaults.maxEntriesPerDay ?? DEFAULT_CONFIG.maxEntriesPerDay,
      1,
      500,
      DEFAULT_CONFIG.maxEntriesPerDay
    ),
    dedupeWindowMs: clampInt(
      config?.dedupeWindowMs ?? defaults.dedupeWindowMs ?? DEFAULT_CONFIG.dedupeWindowMs,
      60_000,
      14 * 24 * 60 * 60 * 1000,
      DEFAULT_CONFIG.dedupeWindowMs
    ),
    maxSummaryChars: clampInt(
      config?.maxSummaryChars ?? defaults.maxSummaryChars ?? DEFAULT_CONFIG.maxSummaryChars,
      40,
      2000,
      DEFAULT_CONFIG.maxSummaryChars
    ),
    syncOnWrite: config?.syncOnWrite ?? defaults.syncOnWrite ?? DEFAULT_CONFIG.syncOnWrite
  };
}

function normalizeRecords(records: MemoryCheckpointRecord[] | undefined): MemoryCheckpointRecord[] {
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .filter((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      return (
        typeof item.dedupeKey === "string" &&
        typeof item.sessionId === "string" &&
        typeof item.class === "string" &&
        typeof item.source === "string" &&
        typeof item.summary === "string" &&
        typeof item.day === "string" &&
        typeof item.createdAt === "string"
      );
    })
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : randomUUID(),
      dedupeKey: item.dedupeKey,
      sessionId: item.sessionId,
      class: item.class as MemoryCheckpointClass,
      source: item.source,
      summary: item.summary,
      day: item.day,
      createdAt: item.createdAt
    }));
}

function normalizeRuntime(runtime: PersistedState["runtime"] | undefined): PersistedState["runtime"] {
  return {
    writeCount: clampInt(runtime?.writeCount, 0, 1_000_000, 0),
    skippedDuplicateCount: clampInt(runtime?.skippedDuplicateCount, 0, 1_000_000, 0),
    skippedDailyLimitCount: clampInt(runtime?.skippedDailyLimitCount, 0, 1_000_000, 0),
    skippedDisabledCount: clampInt(runtime?.skippedDisabledCount, 0, 1_000_000, 0),
    lastWriteAt: typeof runtime?.lastWriteAt === "string" ? runtime.lastWriteAt : undefined,
    lastSkipReason: typeof runtime?.lastSkipReason === "string" ? runtime.lastSkipReason : undefined
  };
}

function normalizeSummary(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...` : normalized;
}

function normalizeDetails(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}

function normalizeDay(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function isoDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function hashKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value as number);
  return Math.max(min, Math.min(max, parsed));
}
