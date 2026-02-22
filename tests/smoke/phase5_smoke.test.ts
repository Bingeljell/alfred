import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";
import { ReminderStore } from "../../apps/gateway-orchestrator/src/builtins/reminder_store";
import { TaskStore } from "../../apps/gateway-orchestrator/src/builtins/task_store";
import { ApprovalStore } from "../../apps/gateway-orchestrator/src/builtins/approval_store";

describe("phase 5 smoke", () => {
  it("handles key command flows in chat lane", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-phase5-smoke-"));

    const queueStore = new FileBackedQueueStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    const reminderStore = new ReminderStore(stateDir);
    const taskStore = new TaskStore(stateDir);
    const approvalStore = new ApprovalStore(stateDir);

    await queueStore.ensureReady();
    await notificationStore.ensureReady();
    await reminderStore.ensureReady();
    await taskStore.ensureReady();
    await approvalStore.ensureReady();

    const service = new GatewayService(queueStore, notificationStore, reminderStore, taskStore, approvalStore);

    const task = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/task add review phase5",
      requestJob: false
    });
    expect(task.mode).toBe("chat");
    expect(task.response).toContain("Task added");

    const list = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/task list",
      requestJob: false
    });
    expect(list.response).toContain("Open tasks:");

    const status = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/job status does-not-exist",
      requestJob: false
    });
    expect(status.response).toContain("Job not found");
  });
});
