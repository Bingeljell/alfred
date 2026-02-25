import fs from "node:fs/promises";
import path from "node:path";
import { ConversationStore, type ConversationRecord } from "./conversation_store";

export type MemoryCompactionConfig = {
  enabled: boolean;
  intervalMs: number;
  maxDaysPerRun: number;
  minEventsPerDay: number;
  maxEventsPerDay: number;
  maxNoteChars: number;
  sessionId: string;
};

export type MemoryCompactionRuntimeState = {
  lastRunAt?: string;
  nextRunAt?: string;
  lastOutcome?: "compacted" | "skipped" | "error";
  lastSkipReason?: string;
  lastError?: string;
  runCount: number;
  compactedDayCount: number;
  skippedNoDataDayCount: number;
  skippedAlreadyProcessedCount: number;
  errorCount: number;
  cursorDate?: string;
  lastCompactedDate?: string;
  lastCompactedEventCount?: number;
};

export type MemoryCompactionStatus = {
  running: boolean;
  inFlight: boolean;
  config: MemoryCompactionConfig;
  runtime: MemoryCompactionRuntimeState;
};

type MemoryCompactionPersistedState = {
  config: MemoryCompactionConfig;
  runtime: MemoryCompactionRuntimeState;
};

type MemoryCompactionDependencies = {
  conversationStore: ConversationStore;
  memoryService: {
    appendMemoryNote: (text: string, date?: string) => Promise<{ path: string }>;
    syncMemory: (reason?: string) => Promise<void>;
  };
  defaultConfig?: Partial<MemoryCompactionConfig>;
};

const DEFAULT_MEMORY_COMPACTION_CONFIG: MemoryCompactionConfig = {
  enabled: true,
  intervalMs: 60 * 60 * 1000,
  maxDaysPerRun: 2,
  minEventsPerDay: 6,
  maxEventsPerDay: 600,
  maxNoteChars: 8000,
  sessionId: "owner@s.whatsapp.net"
};

const DEFAULT_RUNTIME: MemoryCompactionRuntimeState = {
  runCount: 0,
  compactedDayCount: 0,
  skippedNoDataDayCount: 0,
  skippedAlreadyProcessedCount: 0,
  errorCount: 0
};

export class MemoryCompactionService {
  private readonly filePath: string;
  private readonly conversationStore: ConversationStore;
  private readonly memoryService: MemoryCompactionDependencies["memoryService"];
  private readonly defaultConfig: Partial<MemoryCompactionConfig>;

  private state?: MemoryCompactionPersistedState;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(stateDir: string, deps: MemoryCompactionDependencies) {
    this.filePath = path.join(stateDir, "builtins", "memory_compaction.json");
    this.conversationStore = deps.conversationStore;
    this.memoryService = deps.memoryService;
    this.defaultConfig = deps.defaultConfig ?? {};
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const loaded = await this.readPersistedState();
    if (loaded) {
      this.state = {
        config: normalizeConfig(loaded.config, this.defaultConfig),
        runtime: normalizeRuntime(loaded.runtime)
      };
    } else {
      this.state = {
        config: normalizeConfig(undefined, this.defaultConfig),
        runtime: normalizeRuntime(undefined)
      };
    }

    await this.persist();
  }

  async start(): Promise<void> {
    await this.ensureReady();
    if (this.running) {
      return;
    }
    this.running = true;

    await this.executeTick("startup", false, undefined, new Date());
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.ensureReady();
    this.state!.runtime.nextRunAt = undefined;
    await this.persist();
  }

  async status(): Promise<MemoryCompactionStatus> {
    await this.ensureReady();
    return {
      running: this.running,
      inFlight: this.inFlight,
      config: this.state!.config,
      runtime: this.state!.runtime
    };
  }

  async configure(patch: Partial<MemoryCompactionConfig>): Promise<MemoryCompactionStatus> {
    await this.ensureReady();
    this.state!.config = normalizeConfig(
      {
        ...this.state!.config,
        ...patch
      },
      this.defaultConfig
    );
    await this.persist();

    if (this.running) {
      this.scheduleNext();
    }

    return this.status();
  }

  async runNow(options?: {
    force?: boolean;
    targetDate?: string;
    trigger?: string;
    now?: Date;
  }): Promise<MemoryCompactionStatus> {
    await this.ensureReady();
    await this.executeTick(
      options?.trigger ?? "manual",
      options?.force ?? true,
      options?.targetDate,
      options?.now ?? new Date()
    );

    if (this.running) {
      this.scheduleNext();
    }

    return this.status();
  }

  private scheduleNext(): void {
    if (!this.running || !this.state) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const intervalMs = this.state.config.intervalMs;
    this.state.runtime.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    void this.persist();

    this.timer = setTimeout(() => {
      void this.executeTick("interval", false, undefined, new Date()).finally(() => {
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, intervalMs);
  }

  private async executeTick(trigger: string, force: boolean, targetDate: string | undefined, now: Date): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;

    try {
      await this.ensureReady();
      const config = this.state!.config;
      const runtime = this.state!.runtime;
      runtime.runCount += 1;
      runtime.lastRunAt = now.toISOString();
      runtime.lastError = undefined;
      runtime.lastSkipReason = undefined;

      if (!force && !config.enabled) {
        runtime.lastOutcome = "skipped";
        runtime.lastSkipReason = "disabled";
        runtime.skippedAlreadyProcessedCount += 1;
        await this.persist();
        return;
      }

      const latestProcessableDate = previousUtcDate(now);
      if (!latestProcessableDate) {
        runtime.lastOutcome = "skipped";
        runtime.lastSkipReason = "no_processable_day";
        runtime.skippedAlreadyProcessedCount += 1;
        await this.persist();
        return;
      }

      const normalizedTargetDate = normalizeDay(targetDate);
      if (targetDate && !normalizedTargetDate) {
        runtime.lastOutcome = "error";
        runtime.errorCount += 1;
        runtime.lastError = "invalid_target_date";
        await this.persist();
        return;
      }

      if (normalizedTargetDate && normalizedTargetDate > latestProcessableDate) {
        runtime.lastOutcome = "skipped";
        runtime.lastSkipReason = "target_date_in_future";
        runtime.skippedAlreadyProcessedCount += 1;
        await this.persist();
        return;
      }

      const datesToProcess = normalizedTargetDate
        ? [normalizedTargetDate]
        : buildPendingDates(runtime.cursorDate, latestProcessableDate, config.maxDaysPerRun);

      if (datesToProcess.length === 0) {
        runtime.lastOutcome = "skipped";
        runtime.lastSkipReason = "already_processed";
        runtime.skippedAlreadyProcessedCount += 1;
        await this.persist();
        return;
      }

      let compactedAny = false;
      let lastCompactedDate: string | undefined;
      let lastCompactedEventCount: number | undefined;

      for (const day of datesToProcess) {
        const compacted = await this.compactDay(day, config.maxEventsPerDay, config.minEventsPerDay, config.maxNoteChars, trigger);
        runtime.cursorDate = maxDate(runtime.cursorDate, day);

        if (compacted) {
          compactedAny = true;
          runtime.compactedDayCount += 1;
          runtime.lastCompactedDate = day;
          lastCompactedDate = day;
          lastCompactedEventCount = compacted.eventCount;
          runtime.lastCompactedEventCount = compacted.eventCount;
          continue;
        }

        runtime.skippedNoDataDayCount += 1;
      }

      runtime.lastOutcome = compactedAny ? "compacted" : "skipped";
      runtime.lastSkipReason = compactedAny ? undefined : "insufficient_signal";

      if (compactedAny) {
        await this.memoryService.syncMemory("memory_compaction");
        const message = `[memory] Daily compaction saved for ${lastCompactedDate} (${lastCompactedEventCount} events).`;
        await this.conversationStore.add(config.sessionId, "system", message, {
          source: "memory",
          channel: "internal",
          kind: "status",
          metadata: {
            trigger,
            compactedDate: lastCompactedDate,
            eventCount: lastCompactedEventCount
          }
        });
      }

      await this.persist();
    } catch (error) {
      await this.ensureReady();
      this.state!.runtime.lastOutcome = "error";
      this.state!.runtime.lastError = String(error);
      this.state!.runtime.errorCount += 1;
      await this.persist();
    } finally {
      this.inFlight = false;
    }
  }

  private async compactDay(
    day: string,
    maxEvents: number,
    minEvents: number,
    maxNoteChars: number,
    trigger: string
  ): Promise<{ eventCount: number } | null> {
    const startIso = `${day}T00:00:00.000Z`;
    const endIso = toDayStartIso(addDays(day, 1));
    const events = await this.conversationStore.query({
      since: startIso,
      until: endIso,
      kinds: ["chat", "command", "job", "error"],
      limit: maxEvents
    });

    if (events.length < minEvents) {
      return null;
    }

    const note = buildCompactionNote(day, startIso, endIso, events, maxNoteChars, trigger);
    await this.memoryService.appendMemoryNote(note, day);
    return { eventCount: events.length };
  }

  private async readPersistedState(): Promise<MemoryCompactionPersistedState | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryCompactionPersistedState>;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return {
        config: normalizeConfig(parsed.config, this.defaultConfig),
        runtime: normalizeRuntime(parsed.runtime)
      };
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    if (!this.state) {
      return;
    }
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}

function normalizeConfig(
  input: Partial<MemoryCompactionConfig> | undefined,
  defaults?: Partial<MemoryCompactionConfig>
): MemoryCompactionConfig {
  const merged: MemoryCompactionConfig = {
    ...DEFAULT_MEMORY_COMPACTION_CONFIG,
    ...defaults,
    ...input
  };

  return {
    enabled: Boolean(merged.enabled),
    intervalMs: clampInt(merged.intervalMs, 60_000, 24 * 60 * 60 * 1000, DEFAULT_MEMORY_COMPACTION_CONFIG.intervalMs),
    maxDaysPerRun: clampInt(merged.maxDaysPerRun, 1, 30, DEFAULT_MEMORY_COMPACTION_CONFIG.maxDaysPerRun),
    minEventsPerDay: clampInt(merged.minEventsPerDay, 1, 500, DEFAULT_MEMORY_COMPACTION_CONFIG.minEventsPerDay),
    maxEventsPerDay: clampInt(merged.maxEventsPerDay, 20, 5000, DEFAULT_MEMORY_COMPACTION_CONFIG.maxEventsPerDay),
    maxNoteChars: clampInt(merged.maxNoteChars, 400, 20_000, DEFAULT_MEMORY_COMPACTION_CONFIG.maxNoteChars),
    sessionId:
      typeof merged.sessionId === "string" && merged.sessionId.trim().length > 0
        ? merged.sessionId.trim()
        : DEFAULT_MEMORY_COMPACTION_CONFIG.sessionId
  };
}

function normalizeRuntime(input: Partial<MemoryCompactionRuntimeState> | undefined): MemoryCompactionRuntimeState {
  const merged: MemoryCompactionRuntimeState = {
    ...DEFAULT_RUNTIME,
    ...input
  };
  return {
    ...merged,
    runCount: clampInt(merged.runCount, 0, Number.MAX_SAFE_INTEGER, 0),
    compactedDayCount: clampInt(merged.compactedDayCount, 0, Number.MAX_SAFE_INTEGER, 0),
    skippedNoDataDayCount: clampInt(merged.skippedNoDataDayCount, 0, Number.MAX_SAFE_INTEGER, 0),
    skippedAlreadyProcessedCount: clampInt(merged.skippedAlreadyProcessedCount, 0, Number.MAX_SAFE_INTEGER, 0),
    errorCount: clampInt(merged.errorCount, 0, Number.MAX_SAFE_INTEGER, 0)
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const int = Math.floor(numeric);
  if (int < min) {
    return min;
  }
  if (int > max) {
    return max;
  }
  return int;
}

function normalizeDay(value: string | undefined): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function previousUtcDate(now: Date): string | null {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const previous = new Date(start - 24 * 60 * 60 * 1000);
  if (Number.isNaN(previous.getTime())) {
    return null;
  }
  return previous.toISOString().slice(0, 10);
}

function buildPendingDates(cursorDate: string | undefined, upToDate: string, maxDays: number): string[] {
  if (cursorDate && cursorDate >= upToDate) {
    return [];
  }

  const dates: string[] = [];
  let current = cursorDate ? addDays(cursorDate, 1) : upToDate;
  while (current <= upToDate && dates.length < maxDays) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function addDays(day: string, amount: number): string {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function toDayStartIso(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function maxDate(a: string | undefined, b: string): string {
  if (!a) {
    return b;
  }
  return a >= b ? a : b;
}

function buildCompactionNote(
  day: string,
  startIso: string,
  endIso: string,
  events: ConversationRecord[],
  maxNoteChars: number,
  trigger: string
): string {
  const ordered = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const kindCounts = countBy(ordered, (item) => item.kind);
  const sourceCounts = countBy(ordered, (item) => item.source);
  const directionCounts = countBy(ordered, (item) => item.direction);
  const sessionCounts = countBy(ordered, (item) => item.sessionId);
  const commandCounts = countCommands(ordered);
  const memoryClassCounts = countBy(ordered, (item) => classifyEventForMemory(item));
  const notable = selectNotableEvents(ordered, 12);

  const lines: string[] = [
    "[memory-compaction] Daily conversation digest",
    `day: ${day}`,
    `window_utc: ${startIso} -> ${endIso}`,
    `trigger: ${trigger}`,
    `events_considered: ${ordered.length}`,
    `sessions_active: ${Object.keys(sessionCounts).length}`,
    `kind_counts: ${formatCounts(kindCounts)}`,
    `direction_counts: ${formatCounts(directionCounts)}`,
    `source_counts: ${formatCounts(sourceCounts)}`,
    `memory_class_counts: ${formatCounts(memoryClassCounts)}`
  ];

  if (Object.keys(commandCounts).length > 0) {
    lines.push(`commands_seen: ${formatCounts(commandCounts)}`);
  }

  lines.push("notable_events:");
  lines.push(...notable.map((event) => `- [${classifyEventForMemory(event)}] ${formatEventLine(event)}`));

  const note = lines.join("\n");
  if (note.length <= maxNoteChars) {
    return note;
  }

  const overflow = "\n- ...truncated";
  return `${note.slice(0, Math.max(0, maxNoteChars - overflow.length))}${overflow}`;
}

function countBy(items: ConversationRecord[], keyOf: (item: ConversationRecord) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function countCommands(items: ConversationRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.direction !== "inbound" && item.kind !== "command") {
      continue;
    }
    const token = item.text.trim().split(/\s+/)[0];
    if (!token || !token.startsWith("/")) {
      continue;
    }
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

function selectNotableEvents(items: ConversationRecord[], limit: number): ConversationRecord[] {
  const nonChat = items.filter((item) => item.kind !== "chat" || classifyEventForMemory(item) !== "fact");
  const chat = items.filter((item) => item.kind === "chat");
  const selected = [...nonChat.slice(-Math.floor(limit / 2)), ...chat.slice(-Math.ceil(limit / 2))];
  const unique = new Map<string, ConversationRecord>();
  for (const item of selected) {
    unique.set(item.id, item);
  }
  return [...unique.values()].slice(-limit);
}

function classifyEventForMemory(event: ConversationRecord): "fact" | "preference" | "todo" | "decision" {
  const text = event.text.toLowerCase();
  if (/\b\/task\s+add\b|\btodo\b|\bremind\b|\bfollow[- ]?up\b/.test(text)) {
    return "todo";
  }
  if (/\b\/task\s+done\b|\bapproved\b|\brejected\b|\bdecision\b|\bpolicy\b/.test(text)) {
    return "decision";
  }
  if (/\bprefer\b|\bpreference\b|\blike to\b|\bstyle\b/.test(text)) {
    return "preference";
  }
  return "fact";
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatEventLine(event: ConversationRecord): string {
  const time = new Date(event.createdAt).toISOString().slice(11, 16);
  const session = formatSessionId(event.sessionId);
  const text = event.text.replace(/\s+/g, " ").trim();
  const clipped = text.length > 180 ? `${text.slice(0, 177)}...` : text;
  return `${time}Z [${session}] ${event.direction}/${event.kind}: ${clipped}`;
}

function formatSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (trimmed.includes("@")) {
    return trimmed.split("@")[0].slice(0, 16);
  }
  return trimmed.slice(0, 16);
}
