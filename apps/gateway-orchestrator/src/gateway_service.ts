import { InboundMessageSchema, JobCreateSchema } from "../../../packages/contracts/src";
import { parseCommand, type ParsedCommand } from "./builtins/command_parser";
import { ApprovalStore } from "./builtins/approval_store";
import { ReminderStore } from "./builtins/reminder_store";
import { TaskStore } from "./builtins/task_store";
import { FileBackedQueueStore } from "./local_queue_store";
import { OutboundNotificationStore } from "./notification_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { normalizeBaileysInbound } from "./whatsapp/normalize_baileys";

export class GatewayService {
  constructor(
    private readonly store: FileBackedQueueStore,
    private readonly notificationStore?: OutboundNotificationStore,
    private readonly reminderStore?: ReminderStore,
    private readonly taskStore?: TaskStore,
    private readonly approvalStore?: ApprovalStore
  ) {}

  async health(): Promise<{
    service: "gateway-orchestrator";
    status: "ok";
    queue: Record<string, number>;
  }> {
    const queue = await this.store.statusCounts();
    return {
      service: "gateway-orchestrator",
      status: "ok",
      queue
    };
  }

  async handleInbound(payload: unknown): Promise<{
    accepted: boolean;
    mode: "chat" | "async-job";
    response?: string;
    jobId?: string;
  }> {
    const inbound = InboundMessageSchema.parse(payload ?? {});

    if (inbound.requestJob) {
      const job = await this.store.createJob({
        type: "stub_task",
        payload: {
          text: inbound.text,
          sessionId: inbound.sessionId,
          ...inbound.metadata
        },
        priority: 5
      });

      await this.queueJobNotification(inbound.sessionId, job.id, "queued", `Job ${job.id} is queued`);

      return {
        accepted: true,
        mode: "async-job",
        jobId: job.id
      };
    }

    if (inbound.text) {
      const command = parseCommand(inbound.text);
      if (command) {
        const response = await this.executeCommand(inbound.sessionId, command);
        return {
          accepted: true,
          mode: "chat",
          response
        };
      }
    }

    return {
      accepted: true,
      mode: "chat",
      response: `ack:${inbound.text ?? ""}`
    };
  }

  async createJob(payload: unknown): Promise<{ jobId: string; status: string }> {
    const input = JobCreateSchema.parse(payload ?? {});
    const job = await this.store.createJob(input);

    const sessionId = typeof input.payload.sessionId === "string" ? input.payload.sessionId : undefined;
    if (sessionId) {
      await this.queueJobNotification(sessionId, job.id, "queued", `Job ${job.id} is queued`);
    }

    return { jobId: job.id, status: job.status };
  }

  async getJob(jobId: string) {
    return this.store.getJob(jobId);
  }

  async cancelJob(jobId: string) {
    return this.store.cancelJob(jobId);
  }

  async retryJob(jobId: string) {
    return this.store.retryJob(jobId);
  }

  async handleBaileysInbound(payload: unknown, dedupeStore: MessageDedupeStore): Promise<{
    accepted: boolean;
    duplicate: boolean;
    mode?: "chat" | "async-job";
    response?: string;
    jobId?: string;
    providerMessageId?: string;
  }> {
    const normalized = normalizeBaileysInbound(payload);
    const duplicate = await dedupeStore.isDuplicateAndMark(normalized.dedupeKey);

    if (duplicate) {
      return {
        accepted: true,
        duplicate: true,
        providerMessageId: normalized.providerMessageId
      };
    }

    const result = await this.handleInbound(normalized.normalized);
    return {
      ...result,
      duplicate: false,
      providerMessageId: normalized.providerMessageId
    };
  }

  private async executeCommand(sessionId: string, command: ParsedCommand): Promise<string> {
    switch (command.kind) {
      case "remind_add": {
        if (!this.reminderStore) {
          return "Reminders are not configured.";
        }

        const parsedDate = new Date(command.remindAt);
        if (Number.isNaN(parsedDate.getTime())) {
          return "Invalid reminder time. Use ISO format, e.g. /remind 2026-02-23T09:00:00Z call mom";
        }

        const reminder = await this.reminderStore.add(sessionId, command.text, parsedDate.toISOString());
        return `Reminder created (${reminder.id}) for ${reminder.remindAt}`;
      }

      case "remind_list": {
        if (!this.reminderStore) {
          return "Reminders are not configured.";
        }

        const reminders = await this.reminderStore.listBySession(sessionId);
        if (reminders.length === 0) {
          return "No pending reminders.";
        }

        const lines = reminders.slice(0, 10).map((item) => `- ${item.id}: ${item.text} @ ${item.remindAt}`);
        return `Pending reminders:\n${lines.join("\n")}`;
      }

      case "task_add": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const task = await this.taskStore.add(sessionId, command.text);
        return `Task added (${task.id}): ${task.text}`;
      }

      case "task_list": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const tasks = await this.taskStore.listOpen(sessionId);
        if (tasks.length === 0) {
          return "No open tasks.";
        }

        return `Open tasks:\n${tasks.slice(0, 10).map((item) => `- ${item.id}: ${item.text}`).join("\n")}`;
      }

      case "task_done": {
        if (!this.taskStore) {
          return "Tasks are not configured.";
        }

        const done = await this.taskStore.markDone(sessionId, command.id);
        if (!done) {
          return `Task not found: ${command.id}`;
        }

        return `Task completed: ${done.id}`;
      }

      case "job_status": {
        const job = await this.store.getJob(command.id);
        if (!job) {
          return `Job not found: ${command.id}`;
        }

        return `Job ${job.id} is ${job.status}`;
      }

      case "job_cancel": {
        const job = await this.store.cancelJob(command.id);
        if (!job) {
          return `Job not found: ${command.id}`;
        }

        return `Job ${job.id} is ${job.status}`;
      }

      case "job_retry": {
        const job = await this.store.retryJob(command.id);
        if (!job) {
          return `Job retry not available for ${command.id} (only failed/cancelled jobs can be retried).`;
        }

        await this.queueJobNotification(sessionId, job.id, "queued", `Job ${job.id} is queued (retry of ${command.id})`);
        return `Retry queued as job ${job.id}`;
      }

      case "side_effect_send": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }

        const approval = await this.approvalStore.create(sessionId, "send_text", { text: command.text });
        return `Approval required for side-effect action. Reply: approve ${approval.token}`;
      }

      case "approve": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }

        const approval = await this.approvalStore.consume(sessionId, command.token);
        if (!approval) {
          return `Approval token invalid or expired: ${command.token}`;
        }

        if (approval.action === "send_text") {
          const text = String(approval.payload.text ?? "");
          return `Approved action executed: send '${text}'`;
        }

        return `Approved action executed: ${approval.action}`;
      }
    }
  }

  private async queueJobNotification(
    sessionId: string,
    jobId: string,
    status: string,
    text: string
  ): Promise<void> {
    if (!this.notificationStore) {
      return;
    }

    await this.notificationStore.enqueue({
      sessionId,
      jobId,
      status,
      text
    });
  }
}
