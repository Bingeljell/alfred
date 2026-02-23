import { InboundMessageSchema, JobCreateSchema } from "../../../packages/contracts/src";
import { parseCommand, type ParsedCommand } from "./builtins/command_parser";
import { ApprovalStore } from "./builtins/approval_store";
import { NoteStore } from "./builtins/note_store";
import { ReminderStore } from "./builtins/reminder_store";
import { TaskStore } from "./builtins/task_store";
import { FileBackedQueueStore } from "./local_queue_store";
import { OutboundNotificationStore } from "./notification_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { normalizeBaileysInbound } from "./whatsapp/normalize_baileys";
import { OAuthService } from "./auth/oauth_service";
import { CodexAuthService, type CodexLoginStartMode } from "./codex/auth_service";
import { ConversationStore } from "./builtins/conversation_store";
import { IdentityProfileStore } from "./auth/identity_profile_store";

export class GatewayService {
  constructor(
    private readonly store: FileBackedQueueStore,
    private readonly notificationStore?: OutboundNotificationStore,
    private readonly reminderStore?: ReminderStore,
    private readonly noteStore?: NoteStore,
    private readonly taskStore?: TaskStore,
    private readonly approvalStore?: ApprovalStore,
    private readonly oauthService?: OAuthService,
    private readonly llmService?: { generateText: (sessionId: string, input: string) => Promise<{ text: string } | null> },
    private readonly codexAuthService?: CodexAuthService,
    private readonly codexLoginMode: CodexLoginStartMode = "chatgpt",
    private readonly codexApiKey?: string,
    private readonly conversationStore?: ConversationStore,
    private readonly identityProfileStore?: IdentityProfileStore
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
    const provider = String(inbound.metadata?.provider ?? "");
    const source = provider === "baileys" ? "whatsapp" : "gateway";
    const channel = provider === "baileys" ? "baileys" : "direct";
    const authSessionId = await this.resolveAuthSessionId(inbound.sessionId, provider);
    await this.recordConversation(inbound.sessionId, "inbound", inbound.text ?? "", {
      source,
      channel,
      kind: inbound.requestJob ? "job" : "chat",
      metadata: {
        ...(inbound.metadata && typeof inbound.metadata === "object" ? inbound.metadata : {}),
        authSessionId
      }
    });

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
      await this.recordConversation(inbound.sessionId, "outbound", `Job ${job.id} queued`, {
        source: "gateway",
        channel: "internal",
        kind: "job",
        metadata: { jobId: job.id, status: "queued" }
      });

      return {
        accepted: true,
        mode: "async-job",
        jobId: job.id
      };
    }

    if (inbound.text) {
      const command = parseCommand(inbound.text);
      if (command) {
        const response = await this.executeCommand(inbound.sessionId, command, authSessionId);
        await this.recordConversation(inbound.sessionId, "outbound", response, {
          source: "gateway",
          channel: "internal",
          kind: "command",
          metadata: {
            authSessionId
          }
        });
        return {
          accepted: true,
          mode: "chat",
          response
        };
      }

      const response = await this.executeChatTurn(authSessionId, inbound.text);
      await this.recordConversation(inbound.sessionId, "outbound", response, {
        source: "gateway",
        channel: "internal",
        kind: "chat",
        metadata: {
          authSessionId
        }
      });
      return {
        accepted: true,
        mode: "chat",
        response
      };
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
      await this.recordConversation(normalized.normalized.sessionId, "system", "Dropped duplicate inbound message", {
        source: "whatsapp",
        channel: "baileys",
        kind: "dedupe",
        metadata: { providerMessageId: normalized.providerMessageId }
      });
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

  private async executeCommand(sessionId: string, command: ParsedCommand, authSessionId = sessionId): Promise<string> {
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

      case "note_add": {
        if (!this.noteStore) {
          return "Notes are not configured.";
        }

        const note = await this.noteStore.add(sessionId, command.text);
        return `Note added (${note.id}): ${note.text}`;
      }

      case "note_list": {
        if (!this.noteStore) {
          return "Notes are not configured.";
        }

        const notes = await this.noteStore.listBySession(sessionId);
        if (notes.length === 0) {
          return "No saved notes.";
        }

        return `Notes:\n${notes
          .slice(-10)
          .map((item) => `- ${item.id}: ${item.text}`)
          .join("\n")}`;
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

      case "auth_connect": {
        if (this.codexAuthService) {
          const started = await this.codexAuthService.startLogin(this.codexLoginMode, this.codexApiKey);
          if (started.authorizationUrl) {
            return `Open this link to connect Codex (${started.mode}): ${started.authorizationUrl}`;
          }
          return `Codex auth login started (${started.mode}).`;
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const started = await this.oauthService.startOpenAiConnect(authSessionId);
        return `Open this link to connect OpenAI (${started.mode}): ${started.authorizationUrl}`;
      }

      case "auth_status": {
        if (this.codexAuthService) {
          const status = await this.codexAuthService.readStatus(false);
          if (!status.connected) {
            return "Codex auth is not connected.";
          }

          const identity = status.email ? `${status.email}` : "session";
          const plan = status.planType ? ` (${status.planType})` : "";
          return `Codex auth connected as ${identity}${plan}.`;
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const status = await this.oauthService.statusOpenAi(authSessionId);
        if (!status.connected) {
          return "OpenAI OAuth is not connected for this session.";
        }

        const expiry = status.expiresAt ? `, expires ${status.expiresAt}` : "";
        return `OpenAI OAuth connected (${status.mode}, ${status.storageScheme}${expiry}).`;
      }

      case "auth_limits": {
        if (!this.codexAuthService) {
          return "Rate limits are available when Codex auth is configured.";
        }

        const limits = await this.codexAuthService.readRateLimits();
        const primary = limits.rateLimits?.primary;
        if (!primary) {
          return "Codex rate limits unavailable.";
        }

        const used = `${Math.round(primary.usedPercent * 100) / 100}%`;
        const reset = primary.resetsAt ? new Date(primary.resetsAt * 1000).toISOString() : "unknown";
        const label = limits.rateLimits?.limitName ?? limits.rateLimits?.limitId ?? "default";
        return `Codex rate limit (${label}): used ${used}, resets at ${reset}`;
      }

      case "auth_disconnect": {
        if (this.codexAuthService) {
          await this.codexAuthService.logout();
          return "Codex auth disconnected.";
        }

        if (!this.oauthService) {
          return "OAuth is not configured.";
        }

        const removed = await this.oauthService.disconnectOpenAi(authSessionId);
        return removed ? "OpenAI OAuth token removed for this session." : "No OpenAI OAuth token found for this session.";
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

  private async executeChatTurn(sessionId: string, text: string): Promise<string> {
    if (!this.llmService) {
      return `ack:${text}`;
    }

    try {
      const result = await this.llmService.generateText(sessionId, text);
      if (!result || !result.text) {
        return `ack:${text}`;
      }
      return result.text;
    } catch (error) {
      return `llm_error:${error instanceof Error ? error.message : String(error)}`;
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

  private async recordConversation(
    sessionId: string,
    direction: "inbound" | "outbound" | "system",
    text: string,
    options?: {
      source?: "gateway" | "whatsapp" | "auth" | "memory" | "worker" | "system";
      channel?: "direct" | "baileys" | "api" | "internal";
      kind?: "chat" | "command" | "job" | "status" | "error" | "dedupe";
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.conversationStore) {
      return;
    }
    try {
      await this.conversationStore.add(sessionId, direction, text, options);
    } catch {
      // Observability is best-effort; never block user flows.
    }
  }

  private async resolveAuthSessionId(channelSessionId: string, provider: string): Promise<string> {
    if (provider !== "baileys" || !this.identityProfileStore) {
      return channelSessionId;
    }

    try {
      return await this.identityProfileStore.resolveAuthSession(channelSessionId);
    } catch {
      return channelSessionId;
    }
  }
}
