import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../../apps/gateway-orchestrator/src/builtins/conversation_store";
import { HeartbeatService } from "../../apps/gateway-orchestrator/src/builtins/heartbeat_service";
import { ReminderStore } from "../../apps/gateway-orchestrator/src/builtins/reminder_store";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";

function tempStateDir(tag: string): string {
  return path.join(os.tmpdir(), `alfred-heartbeat-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

describe("HeartbeatService", () => {
  it("emits an alert for due reminders and dedupes repeated identical alerts", async () => {
    const stateDir = tempStateDir("alerts");
    const queueStore = new FileBackedQueueStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    const reminderStore = new ReminderStore(stateDir);
    const conversationStore = new ConversationStore(stateDir);

    await queueStore.ensureReady();
    await notificationStore.ensureReady();
    await reminderStore.ensureReady();
    await conversationStore.ensureReady();

    await reminderStore.add("owner@s.whatsapp.net", "pay rent", new Date(Date.now() - 60_000).toISOString());

    const heartbeat = new HeartbeatService(stateDir, {
      queueStore,
      notificationStore,
      reminderStore,
      conversationStore,
      defaultConfig: {
        sessionId: "owner@s.whatsapp.net",
        suppressOk: true,
        pendingNotificationAlertThreshold: 100
      }
    });

    await heartbeat.ensureReady();

    const firstRun = await heartbeat.runNow({ force: true, trigger: "test_due_reminder" });
    expect(firstRun.runtime.lastOutcome).toBe("alert");
    expect(firstRun.runtime.alertCount).toBe(1);
    expect(firstRun.runtime.lastAlertText).toContain("Due reminders pending: 1.");

    const pendingAfterFirst = await notificationStore.listPending();
    expect(pendingAfterFirst).toHaveLength(1);
    expect(pendingAfterFirst[0].text).toContain("[heartbeat] Attention needed");

    const secondRun = await heartbeat.runNow({ force: true, trigger: "test_due_reminder_repeat" });
    expect(secondRun.runtime.lastOutcome).toBe("deduped");
    expect(secondRun.runtime.alertCount).toBe(1);
    expect(secondRun.runtime.dedupedCount).toBe(1);

    const pendingAfterSecond = await notificationStore.listPending();
    expect(pendingAfterSecond).toHaveLength(1);
  });

  it("skips scheduled run when queue is busy and idle-queue gate is enabled", async () => {
    const stateDir = tempStateDir("queue-busy");
    const queueStore = new FileBackedQueueStore(stateDir);

    await queueStore.ensureReady();
    await queueStore.createJob({
      type: "stub_task",
      payload: { action: "queue-busy" },
      priority: 5
    });

    const heartbeat = new HeartbeatService(stateDir, {
      queueStore,
      defaultConfig: {
        enabled: true,
        requireIdleQueue: true,
        sessionId: "owner@s.whatsapp.net"
      }
    });

    await heartbeat.ensureReady();
    const status = await heartbeat.runNow({ force: false, trigger: "test_queue_busy" });

    expect(status.runtime.lastOutcome).toBe("skipped");
    expect(status.runtime.lastSkipReason).toBe("queue_busy");
    expect(status.runtime.skippedCount).toBe(1);
  });

  it("updates heartbeat config through configure", async () => {
    const stateDir = tempStateDir("configure");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const heartbeat = new HeartbeatService(stateDir, {
      queueStore
    });

    await heartbeat.ensureReady();
    const updated = await heartbeat.configure({
      enabled: false,
      intervalMs: 45_000,
      activeHoursStart: 7,
      activeHoursEnd: 20,
      sessionId: "configured-session"
    });

    expect(updated.config.enabled).toBe(false);
    expect(updated.config.intervalMs).toBe(45_000);
    expect(updated.config.activeHoursStart).toBe(7);
    expect(updated.config.activeHoursEnd).toBe(20);
    expect(updated.config.sessionId).toBe("configured-session");
  });
});
