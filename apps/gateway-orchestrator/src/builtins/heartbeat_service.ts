import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { JobStatus } from "../../../../packages/contracts/src";
import { FileBackedQueueStore } from "../local_queue_store";
import { OutboundNotificationStore } from "../notification_store";
import { ConversationStore } from "./conversation_store";
import { ReminderStore } from "./reminder_store";

export type HeartbeatRunOutcome = "ok" | "alert" | "deduped" | "skipped" | "error";

export type HeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
  activeHoursStart: number;
  activeHoursEnd: number;
  requireIdleQueue: boolean;
  dedupeWindowMs: number;
  suppressOk: boolean;
  sessionId: string;
  pendingNotificationAlertThreshold: number;
  recentErrorLookbackMinutes: number;
  alertOnAuthDisconnected: boolean;
  alertOnWhatsAppDisconnected: boolean;
  alertOnStuckJobs: boolean;
  stuckJobThresholdMinutes: number;
};

export type HeartbeatRuntimeState = {
  lastRunAt?: string;
  nextRunAt?: string;
  lastOutcome?: HeartbeatRunOutcome;
  lastSkipReason?: string;
  lastAlertAt?: string;
  lastAlertHash?: string;
  lastAlertText?: string;
  lastError?: string;
  runCount: number;
  okCount: number;
  alertCount: number;
  skippedCount: number;
  dedupedCount: number;
  errorCount: number;
  lastKnownAuthConnected?: boolean;
  lastKnownWhatsAppConnected?: boolean;
  lastSignals?: {
    trigger: string;
    forced: boolean;
    queue: Record<JobStatus, number>;
    dueReminderCount: number;
    pendingNotificationCount: number;
    recentErrorCount: number;
    authAvailable: boolean;
    authConnected: boolean;
    whatsAppAvailable: boolean;
    whatsAppConnected: boolean;
    stuckRunningJobCount: number;
    maxRunningJobAgeMinutes: number;
  };
};

export type HeartbeatStatus = {
  running: boolean;
  inFlight: boolean;
  config: HeartbeatConfig;
  runtime: HeartbeatRuntimeState;
};

type HeartbeatPersistedState = {
  config: HeartbeatConfig;
  runtime: HeartbeatRuntimeState;
};

type HeartbeatDependencies = {
  queueStore: FileBackedQueueStore;
  notificationStore?: OutboundNotificationStore;
  reminderStore?: ReminderStore;
  conversationStore?: ConversationStore;
  readAuthStatus?: (sessionId: string) => Promise<{ available: boolean; connected: boolean; detail?: string; error?: string }>;
  readWhatsAppStatus?: () => Promise<{ available: boolean; connected: boolean; state?: string; error?: string }>;
  defaultConfig?: Partial<HeartbeatConfig>;
};

const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMs: 30 * 60 * 1000,
  activeHoursStart: 9,
  activeHoursEnd: 22,
  requireIdleQueue: true,
  dedupeWindowMs: 2 * 60 * 60 * 1000,
  suppressOk: true,
  sessionId: "owner@s.whatsapp.net",
  pendingNotificationAlertThreshold: 5,
  recentErrorLookbackMinutes: 120,
  alertOnAuthDisconnected: true,
  alertOnWhatsAppDisconnected: true,
  alertOnStuckJobs: true,
  stuckJobThresholdMinutes: 30
};

const DEFAULT_HEARTBEAT_RUNTIME: HeartbeatRuntimeState = {
  runCount: 0,
  okCount: 0,
  alertCount: 0,
  skippedCount: 0,
  dedupedCount: 0,
  errorCount: 0
};

export class HeartbeatService {
  private readonly filePath: string;
  private readonly queueStore: FileBackedQueueStore;
  private readonly notificationStore?: OutboundNotificationStore;
  private readonly reminderStore?: ReminderStore;
  private readonly conversationStore?: ConversationStore;
  private readonly readAuthStatus?: (
    sessionId: string
  ) => Promise<{ available: boolean; connected: boolean; detail?: string; error?: string }>;
  private readonly readWhatsAppStatus?: () => Promise<{ available: boolean; connected: boolean; state?: string; error?: string }>;
  private readonly defaultConfig: Partial<HeartbeatConfig>;

  private state?: HeartbeatPersistedState;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  constructor(stateDir: string, deps: HeartbeatDependencies) {
    this.filePath = path.join(stateDir, "builtins", "heartbeat.json");
    this.queueStore = deps.queueStore;
    this.notificationStore = deps.notificationStore;
    this.reminderStore = deps.reminderStore;
    this.conversationStore = deps.conversationStore;
    this.readAuthStatus = deps.readAuthStatus;
    this.readWhatsAppStatus = deps.readWhatsAppStatus;
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

  async status(): Promise<HeartbeatStatus> {
    await this.ensureReady();
    return {
      running: this.running,
      inFlight: this.inFlight,
      config: this.state!.config,
      runtime: this.state!.runtime
    };
  }

  async configure(patch: Partial<HeartbeatConfig>): Promise<HeartbeatStatus> {
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

  async runNow(options?: { force?: boolean; trigger?: string }): Promise<HeartbeatStatus> {
    await this.ensureReady();
    await this.executeTick(options?.trigger ?? "manual", options?.force ?? true);

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
      void this.executeTick("interval", false).finally(() => {
        if (this.running) {
          this.scheduleNext();
        }
      });
    }, intervalMs);
  }

  private async executeTick(trigger: string, force: boolean): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.ensureReady();
      const now = new Date();
      const nowIso = now.toISOString();
      const runtime = this.state!.runtime;
      const config = this.state!.config;
      const previousLastRunAt = runtime.lastRunAt;

      runtime.runCount += 1;
      runtime.lastRunAt = nowIso;
      runtime.lastError = undefined;
      runtime.lastSkipReason = undefined;

      const queue = await this.queueStore.statusCounts();
      const dueReminderCount = this.reminderStore ? (await this.reminderStore.listDue(now)).length : 0;
      const pendingNotificationCount = this.notificationStore ? (await this.notificationStore.listPending()).length : 0;
      const { stuckRunningJobCount, maxRunningJobAgeMinutes } = await this.readStuckJobSignals(now, config.stuckJobThresholdMinutes);
      const authStatus = this.readAuthStatus
        ? await this.readAuthStatus(config.sessionId)
        : { available: false, connected: false };
      const whatsAppStatus = this.readWhatsAppStatus
        ? await this.readWhatsAppStatus()
        : { available: false, connected: false };

      const lookbackAnchor = previousLastRunAt ?? new Date(now.getTime() - config.recentErrorLookbackMinutes * 60_000).toISOString();
      const recentErrorCount = this.conversationStore
        ? (
            await this.conversationStore.query({
              kinds: ["error"],
              since: lookbackAnchor,
              limit: 200
            })
          ).length
        : 0;

      runtime.lastSignals = {
        trigger,
        forced: force,
        queue,
        dueReminderCount,
        pendingNotificationCount,
        recentErrorCount,
        authAvailable: authStatus.available,
        authConnected: authStatus.connected,
        whatsAppAvailable: whatsAppStatus.available,
        whatsAppConnected: whatsAppStatus.connected,
        stuckRunningJobCount,
        maxRunningJobAgeMinutes
      };

      if (!force) {
        if (!config.enabled) {
          runtime.lastOutcome = "skipped";
          runtime.lastSkipReason = "disabled";
          runtime.skippedCount += 1;
          await this.persist();
          return;
        }

        if (!isWithinActiveHours(now, config.activeHoursStart, config.activeHoursEnd)) {
          runtime.lastOutcome = "skipped";
          runtime.lastSkipReason = "outside_active_hours";
          runtime.skippedCount += 1;
          await this.persist();
          return;
        }

        if (config.requireIdleQueue && isQueueBusy(queue)) {
          runtime.lastOutcome = "skipped";
          runtime.lastSkipReason = "queue_busy";
          runtime.skippedCount += 1;
          await this.persist();
          return;
        }
      }

      const alerts: string[] = [];
      if (dueReminderCount > 0) {
        alerts.push(`Due reminders pending: ${dueReminderCount}.`);
      }
      if (pendingNotificationCount >= config.pendingNotificationAlertThreshold) {
        alerts.push(
          `Outbound notification backlog is ${pendingNotificationCount} (threshold ${config.pendingNotificationAlertThreshold}).`
        );
      }
      if (recentErrorCount > 0) {
        alerts.push(`Recent error events observed: ${recentErrorCount}.`);
      }
      if (
        config.alertOnAuthDisconnected &&
        authStatus.available &&
        !authStatus.connected &&
        runtime.lastKnownAuthConnected === true
      ) {
        alerts.push(`OpenAI auth disconnected${authStatus.detail ? ` (${authStatus.detail})` : ""}.`);
      }
      if (
        config.alertOnWhatsAppDisconnected &&
        whatsAppStatus.available &&
        !whatsAppStatus.connected &&
        runtime.lastKnownWhatsAppConnected === true
      ) {
        const stateSuffix = whatsAppStatus.state ? ` (state=${whatsAppStatus.state})` : "";
        alerts.push(`WhatsApp connection disconnected${stateSuffix}.`);
      }
      if (config.alertOnStuckJobs && stuckRunningJobCount > 0) {
        alerts.push(
          `Long-running jobs detected: ${stuckRunningJobCount} (oldest age ${maxRunningJobAgeMinutes}m, threshold ${config.stuckJobThresholdMinutes}m).`
        );
      }
      if (!config.requireIdleQueue && isQueueBusy(queue)) {
        alerts.push(`Queue is active (queued=${queue.queued}, running=${queue.running}, cancelling=${queue.cancelling}).`);
      }

      if (authStatus.available && authStatus.connected) {
        runtime.lastKnownAuthConnected = true;
      } else if (authStatus.available && !authStatus.connected && runtime.lastKnownAuthConnected !== true) {
        runtime.lastKnownAuthConnected = false;
      }

      if (whatsAppStatus.available && whatsAppStatus.connected) {
        runtime.lastKnownWhatsAppConnected = true;
      } else if (
        whatsAppStatus.available &&
        !whatsAppStatus.connected &&
        runtime.lastKnownWhatsAppConnected !== true
      ) {
        runtime.lastKnownWhatsAppConnected = false;
      }

      if (alerts.length === 0) {
        runtime.lastOutcome = "ok";
        runtime.okCount += 1;
        if (!config.suppressOk) {
          const message = "HEARTBEAT_OK";
          await this.dispatchNotification(config.sessionId, message, {
            heartbeat: true,
            outcome: "ok",
            trigger
          });
        }
        await this.persist();
        return;
      }

      const alertText = buildAlertText(nowIso, alerts);
      const alertHash = hashText(alerts.join("\n"));
      const dedupeActive =
        !!runtime.lastAlertHash &&
        runtime.lastAlertHash === alertHash &&
        isWithinWindow(runtime.lastAlertAt, now, config.dedupeWindowMs);

      if (dedupeActive) {
        runtime.lastOutcome = "deduped";
        runtime.dedupedCount += 1;
        await this.persist();
        return;
      }

      runtime.lastOutcome = "alert";
      runtime.alertCount += 1;
      runtime.lastAlertAt = nowIso;
      runtime.lastAlertHash = alertHash;
      runtime.lastAlertText = alertText;

      await this.dispatchNotification(config.sessionId, alertText, {
        heartbeat: true,
        outcome: "alert",
        trigger,
        dedupeHash: alertHash
      });
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

  private async readStuckJobSignals(
    now: Date,
    thresholdMinutes: number
  ): Promise<{ stuckRunningJobCount: number; maxRunningJobAgeMinutes: number }> {
    if (thresholdMinutes <= 0) {
      return { stuckRunningJobCount: 0, maxRunningJobAgeMinutes: 0 };
    }

    const jobs = await this.queueStore.listJobs();
    let stuckRunningJobCount = 0;
    let maxRunningJobAgeMinutes = 0;

    for (const job of jobs) {
      if (job.status !== "running" || !job.startedAt) {
        continue;
      }

      const startedUnixMs = Date.parse(job.startedAt);
      if (!Number.isFinite(startedUnixMs)) {
        continue;
      }

      const ageMinutes = Math.max(0, Math.floor((now.getTime() - startedUnixMs) / 60000));
      if (ageMinutes < thresholdMinutes) {
        continue;
      }

      stuckRunningJobCount += 1;
      if (ageMinutes > maxRunningJobAgeMinutes) {
        maxRunningJobAgeMinutes = ageMinutes;
      }
    }

    return { stuckRunningJobCount, maxRunningJobAgeMinutes };
  }

  private async dispatchNotification(
    sessionId: string,
    text: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (this.notificationStore) {
      await this.notificationStore.enqueue({
        sessionId,
        text,
        status: "heartbeat"
      });
    }

    if (this.conversationStore) {
      await this.conversationStore.add(sessionId, "system", text, {
        source: "system",
        channel: "internal",
        kind: "status",
        metadata
      });
    }
  }

  private async readPersistedState(): Promise<HeartbeatPersistedState | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HeartbeatPersistedState>;
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

function normalizeConfig(input: Partial<HeartbeatConfig> | undefined, defaults?: Partial<HeartbeatConfig>): HeartbeatConfig {
  const merged: HeartbeatConfig = {
    ...DEFAULT_HEARTBEAT_CONFIG,
    ...defaults,
    ...input
  };

  return {
    enabled: Boolean(merged.enabled),
    intervalMs: clampInt(merged.intervalMs, 15_000, 86_400_000, DEFAULT_HEARTBEAT_CONFIG.intervalMs),
    activeHoursStart: clampInt(merged.activeHoursStart, 0, 23, DEFAULT_HEARTBEAT_CONFIG.activeHoursStart),
    activeHoursEnd: clampInt(merged.activeHoursEnd, 0, 23, DEFAULT_HEARTBEAT_CONFIG.activeHoursEnd),
    requireIdleQueue: Boolean(merged.requireIdleQueue),
    dedupeWindowMs: clampInt(merged.dedupeWindowMs, 0, 7 * 24 * 60 * 60 * 1000, DEFAULT_HEARTBEAT_CONFIG.dedupeWindowMs),
    suppressOk: Boolean(merged.suppressOk),
    sessionId:
      typeof merged.sessionId === "string" && merged.sessionId.trim().length > 0
        ? merged.sessionId.trim()
        : DEFAULT_HEARTBEAT_CONFIG.sessionId,
    pendingNotificationAlertThreshold: clampInt(
      merged.pendingNotificationAlertThreshold,
      1,
      1000,
      DEFAULT_HEARTBEAT_CONFIG.pendingNotificationAlertThreshold
    ),
    recentErrorLookbackMinutes: clampInt(
      merged.recentErrorLookbackMinutes,
      1,
      24 * 60,
      DEFAULT_HEARTBEAT_CONFIG.recentErrorLookbackMinutes
    ),
    alertOnAuthDisconnected: Boolean(merged.alertOnAuthDisconnected),
    alertOnWhatsAppDisconnected: Boolean(merged.alertOnWhatsAppDisconnected),
    alertOnStuckJobs: Boolean(merged.alertOnStuckJobs),
    stuckJobThresholdMinutes: clampInt(
      merged.stuckJobThresholdMinutes,
      1,
      24 * 60,
      DEFAULT_HEARTBEAT_CONFIG.stuckJobThresholdMinutes
    )
  };
}

function normalizeRuntime(input: Partial<HeartbeatRuntimeState> | undefined): HeartbeatRuntimeState {
  const merged: HeartbeatRuntimeState = {
    ...DEFAULT_HEARTBEAT_RUNTIME,
    ...input
  };

  return {
    ...merged,
    runCount: clampInt(merged.runCount, 0, Number.MAX_SAFE_INTEGER, 0),
    okCount: clampInt(merged.okCount, 0, Number.MAX_SAFE_INTEGER, 0),
    alertCount: clampInt(merged.alertCount, 0, Number.MAX_SAFE_INTEGER, 0),
    skippedCount: clampInt(merged.skippedCount, 0, Number.MAX_SAFE_INTEGER, 0),
    dedupedCount: clampInt(merged.dedupedCount, 0, Number.MAX_SAFE_INTEGER, 0),
    errorCount: clampInt(merged.errorCount, 0, Number.MAX_SAFE_INTEGER, 0),
    lastKnownAuthConnected: typeof merged.lastKnownAuthConnected === "boolean" ? merged.lastKnownAuthConnected : undefined,
    lastKnownWhatsAppConnected:
      typeof merged.lastKnownWhatsAppConnected === "boolean" ? merged.lastKnownWhatsAppConnected : undefined
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

function isQueueBusy(queue: Record<JobStatus, number>): boolean {
  return queue.queued > 0 || queue.running > 0 || queue.cancelling > 0;
}

function isWithinActiveHours(now: Date, start: number, end: number): boolean {
  if (start === end) {
    return true;
  }

  const hour = now.getHours();
  if (start < end) {
    return hour >= start && hour < end;
  }

  return hour >= start || hour < end;
}

function isWithinWindow(previousIso: string | undefined, now: Date, windowMs: number): boolean {
  if (!previousIso || windowMs <= 0) {
    return false;
  }

  const previousUnixMs = Date.parse(previousIso);
  if (!Number.isFinite(previousUnixMs)) {
    return false;
  }

  return now.getTime() - previousUnixMs <= windowMs;
}

function buildAlertText(nowIso: string, alerts: string[]): string {
  const lines = ["[heartbeat] Attention needed", `timestamp: ${nowIso}`, ...alerts.map((line) => `- ${line}`)];
  return lines.join("\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
