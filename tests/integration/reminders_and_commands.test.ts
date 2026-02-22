import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";
import { startNotificationDispatcher } from "../../apps/gateway-orchestrator/src/notification_dispatcher";
import { ApprovalStore } from "../../apps/gateway-orchestrator/src/builtins/approval_store";
import { NoteStore } from "../../apps/gateway-orchestrator/src/builtins/note_store";
import { ReminderStore } from "../../apps/gateway-orchestrator/src/builtins/reminder_store";
import { startReminderDispatcher } from "../../apps/gateway-orchestrator/src/builtins/reminder_dispatcher";
import { TaskStore } from "../../apps/gateway-orchestrator/src/builtins/task_store";
import { startWorker } from "../../apps/worker/src/worker";
import { InMemoryWhatsAppAdapter } from "../../packages/provider-adapters/src";
import { waitFor } from "../helpers/wait_for";

describe("phase 5 integration", () => {
  it("supports reminders, task commands, approvals, and job retry", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-phase5-int-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    const reminderStore = new ReminderStore(stateDir);
    const noteStore = new NoteStore(stateDir);
    const taskStore = new TaskStore(stateDir);
    const approvalStore = new ApprovalStore(stateDir);

    await queueStore.ensureReady();
    await notificationStore.ensureReady();
    await reminderStore.ensureReady();
    await noteStore.ensureReady();
    await taskStore.ensureReady();
    await approvalStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      notificationStore,
      reminderStore,
      noteStore,
      taskStore,
      approvalStore
    );

    const adapter = new InMemoryWhatsAppAdapter();
    const notificationDispatcher = startNotificationDispatcher({
      store: notificationStore,
      adapter,
      pollIntervalMs: 10
    });
    const reminderDispatcher = startReminderDispatcher({
      reminderStore,
      notificationStore,
      pollIntervalMs: 10
    });

    const worker = startWorker({
      store: queueStore,
      workerId: "worker-phase5-int",
      pollIntervalMs: 10,
      processor: async (job) => {
        const action = String(job.payload.action ?? job.payload.text ?? "");
        if (action === "fail-me" && !job.retryOf) {
          throw new Error("forced fail");
        }

        return { summary: `processed:${action}` };
      },
      onStatusChange: async (event) => {
        if (!event.sessionId) {
          return;
        }

        await notificationStore.enqueue({
          sessionId: event.sessionId,
          jobId: event.jobId,
          status: event.status,
          text: `Job ${event.jobId} is ${event.status}`
        });
      }
    });

    const taskAdd = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/task add Buy milk",
      requestJob: false
    });

    expect(taskAdd.response).toContain("Task added");

    const taskId = String(taskAdd.response?.match(/\(([^)]+)\)/)?.[1] ?? "");

    const taskDone = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/task done ${taskId}`,
      requestJob: false
    });

    expect(taskDone.response).toContain("Task completed");

    const noteAdd = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/note add Ask dentist for records",
      requestJob: false
    });

    expect(noteAdd.response).toContain("Note added");

    const noteList = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/note list",
      requestJob: false
    });

    expect(noteList.response).toContain("Ask dentist for records");

    const remindAt = new Date(Date.now() + 20).toISOString();
    const reminder = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/remind ${remindAt} stretch`,
      requestJob: false
    });

    expect(reminder.response).toContain("Reminder created");

    await waitFor(async () => {
      const message = adapter.sent.find((entry) => entry.text.includes("Reminder: stretch"));
      return message ?? null;
    });

    const gate = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "send transfer money",
      requestJob: false
    });

    expect(gate.response).toContain("Approval required");

    const token = String(gate.response?.split("approve ")[1] ?? "").trim();
    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `approve ${token}`,
      requestJob: false
    });

    expect(approved.response).toContain("Approved action executed");

    const failing = await service.createJob({
      type: "stub_task",
      payload: { action: "fail-me", sessionId: "owner@s.whatsapp.net" },
      priority: 4
    });

    await waitFor(async () => {
      const job = await service.getJob(failing.jobId);
      return job?.status === "failed" ? job : null;
    });

    const retry = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/job retry ${failing.jobId}`,
      requestJob: false
    });

    expect(retry.response).toContain("Retry queued as job");

    const retriedJobId = String(retry.response?.split(" ").at(-1) ?? "");

    await waitFor(async () => {
      const job = await service.getJob(retriedJobId);
      return job?.status === "succeeded" ? job : null;
    });

    await worker.stop();
    await reminderDispatcher.stop();
    await notificationDispatcher.stop();
  });
});
