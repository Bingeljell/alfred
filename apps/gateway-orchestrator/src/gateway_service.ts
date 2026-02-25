import fs from "node:fs/promises";
import path from "node:path";
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
import type { MemoryResult, MemoryService } from "../../../packages/memory/src";
import type { WebSearchProvider } from "./builtins/web_search_service";

type LlmAuthPreference = "auto" | "oauth" | "api_key";
type ImplicitApprovalDecision = "approve_latest" | "reject_latest";
type ExternalCapability = "web_search" | "file_write";
type RoutedLongTask = {
  taskType: "web_search";
  query: string;
  provider?: WebSearchProvider;
  reason: string;
};

type CapabilityPolicy = {
  workspaceDir: string;
  approvalDefault: boolean;
  webSearchEnabled: boolean;
  webSearchRequireApproval: boolean;
  webSearchProvider: WebSearchProvider;
  fileWriteEnabled: boolean;
  fileWriteRequireApproval: boolean;
  fileWriteNotesOnly: boolean;
  fileWriteNotesDir: string;
};

const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = {
  workspaceDir: path.resolve(process.cwd(), "workspace", "alfred"),
  approvalDefault: true,
  webSearchEnabled: true,
  webSearchRequireApproval: true,
  webSearchProvider: "openai",
  fileWriteEnabled: false,
  fileWriteRequireApproval: true,
  fileWriteNotesOnly: true,
  fileWriteNotesDir: "notes"
};

export class GatewayService {
  private readonly capabilityPolicy: CapabilityPolicy;
  private readonly webSearchService?: {
    search: (
      query: string,
      options: {
        provider?: WebSearchProvider;
        authSessionId: string;
        authPreference?: LlmAuthPreference;
      }
    ) => Promise<{ provider: "openai" | "brave" | "perplexity"; text: string } | null>;
  };

  constructor(
    private readonly store: FileBackedQueueStore,
    private readonly notificationStore?: OutboundNotificationStore,
    private readonly reminderStore?: ReminderStore,
    private readonly noteStore?: NoteStore,
    private readonly taskStore?: TaskStore,
    private readonly approvalStore?: ApprovalStore,
    private readonly oauthService?: OAuthService,
    private readonly llmService?: {
      generateText: (
        sessionId: string,
        input: string,
        options?: { authPreference?: LlmAuthPreference }
      ) => Promise<{ text: string } | null>;
    },
    private readonly codexAuthService?: CodexAuthService,
    private readonly codexLoginMode: CodexLoginStartMode = "chatgpt",
    private readonly codexApiKey?: string,
    private readonly conversationStore?: ConversationStore,
    private readonly identityProfileStore?: IdentityProfileStore,
    private readonly memoryService?: Pick<MemoryService, "searchMemory">,
    capabilityPolicy?: Partial<CapabilityPolicy>,
    webSearchService?: {
      search: (
        query: string,
        options: {
          provider?: WebSearchProvider;
          authSessionId: string;
          authPreference?: LlmAuthPreference;
        }
      ) => Promise<{ provider: "openai" | "brave" | "perplexity"; text: string } | null>;
    },
    private readonly pagedResponseStore?: {
      popNext: (sessionId: string) => Promise<{ page: string; remaining: number } | null>;
      clear: (sessionId: string) => Promise<void>;
    }
  ) {
    this.webSearchService = webSearchService;
    this.capabilityPolicy = {
      ...DEFAULT_CAPABILITY_POLICY,
      ...(capabilityPolicy ?? {}),
      workspaceDir: path.resolve(capabilityPolicy?.workspaceDir ?? DEFAULT_CAPABILITY_POLICY.workspaceDir),
      webSearchProvider: this.normalizeWebSearchProvider(capabilityPolicy?.webSearchProvider) ?? DEFAULT_CAPABILITY_POLICY.webSearchProvider,
      fileWriteNotesDir: (capabilityPolicy?.fileWriteNotesDir ?? DEFAULT_CAPABILITY_POLICY.fileWriteNotesDir).trim() || "notes"
    };
  }

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
    const authPreference = this.normalizeAuthPreference(inbound.metadata?.authPreference);
    await this.recordConversation(inbound.sessionId, "inbound", inbound.text ?? "", {
      source,
      channel,
      kind: inbound.requestJob ? "job" : "chat",
      metadata: {
        ...(inbound.metadata && typeof inbound.metadata === "object" ? inbound.metadata : {}),
        authSessionId,
        authPreference
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
      const paging = await this.handlePagingRequest(inbound.sessionId, inbound.text);
      if (paging) {
        await this.recordConversation(inbound.sessionId, "outbound", paging, {
          source: "gateway",
          channel: "internal",
          kind: "command",
          metadata: { authSessionId }
        });
        return {
          accepted: true,
          mode: "chat",
          response: paging
        };
      }

      const command = parseCommand(inbound.text);
      if (command) {
        const response = await this.executeCommand(inbound.sessionId, command, authSessionId, authPreference);
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

      const implicitApproval = this.parseImplicitApprovalDecision(inbound.text);
      if (implicitApproval) {
        const decisionResult = await this.executeImplicitApprovalDecision(
          inbound.sessionId,
          implicitApproval,
          authSessionId,
          authPreference
        );
        if (decisionResult.handled) {
          await this.recordConversation(inbound.sessionId, "outbound", decisionResult.response, {
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
          response: decisionResult.response
          };
        }
      }

      const progressStatus = await this.answerProgressQuery(inbound.sessionId, inbound.text);
      if (progressStatus) {
        await this.recordConversation(inbound.sessionId, "outbound", progressStatus, {
          source: "gateway",
          channel: "internal",
          kind: "job",
          metadata: {
            authSessionId,
            progressQuery: true
          }
        });
        return {
          accepted: true,
          mode: "chat",
          response: progressStatus
        };
      }

      const routed = await this.routeLongTaskIfNeeded(inbound.sessionId, inbound.text, authSessionId, authPreference);
      if (routed) {
        await this.recordConversation(inbound.sessionId, "outbound", routed.response, {
          source: "gateway",
          channel: "internal",
          kind: "job",
          metadata: {
            authSessionId,
            routedTaskType: routed.taskType,
            reason: routed.reason,
            jobId: routed.jobId
          }
        });
        return {
          accepted: true,
          mode: "async-job",
          response: routed.response,
          jobId: routed.jobId
        };
      }

      const response = await this.executeChatTurn(authSessionId, inbound.text, authPreference);
      await this.recordConversation(inbound.sessionId, "outbound", response, {
        source: "gateway",
        channel: "internal",
        kind: "chat",
        metadata: {
          authSessionId,
          authPreference
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
      response: "No chat text received."
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

  private async executeCommand(
    sessionId: string,
    command: ParsedCommand,
    authSessionId = sessionId,
    authPreference: LlmAuthPreference = "auto"
  ): Promise<string> {
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

      case "policy_status": {
        return [
          "Capability policy:",
          `- workspaceDir: ${this.capabilityPolicy.workspaceDir}`,
          `- approvalDefault: ${String(this.capabilityPolicy.approvalDefault)}`,
          `- webSearch: enabled=${String(this.capabilityPolicy.webSearchEnabled)}, requireApproval=${String(this.capabilityPolicy.webSearchRequireApproval)}, provider=${this.capabilityPolicy.webSearchProvider}`,
          `- fileWrite: enabled=${String(this.capabilityPolicy.fileWriteEnabled)}, requireApproval=${String(this.capabilityPolicy.fileWriteRequireApproval)}, notesOnly=${String(this.capabilityPolicy.fileWriteNotesOnly)}, notesDir=${this.capabilityPolicy.fileWriteNotesDir}`
        ].join("\n");
      }

      case "web_search": {
        if (!this.capabilityPolicy.webSearchEnabled) {
          return "Web search is disabled by policy.";
        }

        if (this.requiresApproval("web_search")) {
          if (!this.approvalStore) {
            return "Approvals are not configured.";
          }
          const approval = await this.approvalStore.create(sessionId, "web_search", {
            query: command.query,
            provider: command.provider ?? this.capabilityPolicy.webSearchProvider,
            authSessionId,
            authPreference
          });
          return `Approval required for web search. Reply: approve ${approval.token}`;
        }
        const provider = command.provider ?? this.capabilityPolicy.webSearchProvider;
        const job = await this.enqueueLongTaskJob(sessionId, {
          taskType: "web_search",
          query: command.query,
          provider,
          authSessionId,
          authPreference,
          reason: "explicit_web_command"
        });
        return `Queued web search as job ${job.id}. I will post progress updates here.`;
      }

      case "file_write": {
        if (!this.capabilityPolicy.fileWriteEnabled) {
          return "File write is disabled by policy. Use /note add for durable notes.";
        }

        const resolved = this.resolveWorkspacePath(command.relativePath);
        if (!resolved.ok) {
          return resolved.error;
        }

        if (this.requiresApproval("file_write")) {
          if (!this.approvalStore) {
            return "Approvals are not configured.";
          }

          const approval = await this.approvalStore.create(sessionId, "file_write", {
            relativePath: command.relativePath,
            text: command.text
          });
          return `Approval required for file write. Reply: approve ${approval.token}`;
        }

        return this.executeFileWrite(resolved.absolutePath, command.text);
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
        return this.executeApprovedAction(approval, sessionId, authSessionId, authPreference);
      }

      case "reject": {
        if (!this.approvalStore) {
          return "Approvals are not configured.";
        }
        const approval = await this.approvalStore.consume(sessionId, command.token);
        if (!approval) {
          return `Approval token invalid or expired: ${command.token}`;
        }
        return `Rejected action: ${approval.action}`;
      }
    }
  }

  private parseImplicitApprovalDecision(rawText: string): ImplicitApprovalDecision | null {
    const value = rawText.trim().toLowerCase();
    if (!value) {
      return null;
    }
    if (value === "yes" || value === "y" || value === "approve" || value === "/approve") {
      return "approve_latest";
    }
    if (value === "no" || value === "n" || value === "reject" || value === "/reject") {
      return "reject_latest";
    }
    return null;
  }

  private async executeImplicitApprovalDecision(
    sessionId: string,
    decision: ImplicitApprovalDecision,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<{ handled: boolean; response: string }> {
    if (!this.approvalStore) {
      return { handled: false, response: "" };
    }

    const pending = await this.approvalStore.peekLatest(sessionId);
    if (!pending) {
      return { handled: false, response: "" };
    }

    if (decision === "reject_latest") {
      const discarded = await this.approvalStore.discardLatest(sessionId);
      if (!discarded) {
        return { handled: false, response: "" };
      }
      return { handled: true, response: `Rejected action: ${discarded.action}` };
    }

    const approval = await this.approvalStore.consumeLatest(sessionId);
    if (!approval) {
      return { handled: false, response: "" };
    }
    const response = await this.executeApprovedAction(approval, sessionId, authSessionId, authPreference);
    return { handled: true, response };
  }

  private async handlePagingRequest(sessionId: string, rawText: string): Promise<string | null> {
    if (!this.pagedResponseStore) {
      return null;
    }
    const value = rawText.trim().toLowerCase();
    if (value !== "#next" && value !== "next") {
      return null;
    }

    const next = await this.pagedResponseStore.popNext(sessionId);
    if (!next) {
      return "No queued paged response is available. Ask a new question or run another long task.";
    }
    const suffix = next.remaining > 0 ? `\n\nReply #next for more (${next.remaining} remaining).` : "";
    return `${next.page}${suffix}`;
  }

  private async answerProgressQuery(sessionId: string, rawText: string): Promise<string | null> {
    if (!this.looksLikeProgressQuery(rawText)) {
      return null;
    }

    const active = await this.findLatestActiveJob(sessionId);
    if (!active) {
      return "No active long-running job for this session.";
    }

    const progress = active.progress?.message ? ` | progress: ${String(active.progress.message)}` : "";
    return `Latest job ${active.id} is ${active.status}${progress}`;
  }

  private async routeLongTaskIfNeeded(
    sessionId: string,
    rawText: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<{ jobId: string; response: string; reason: string; taskType: string } | null> {
    if (!this.capabilityPolicy.webSearchEnabled) {
      return null;
    }
    const routed = this.detectLongTaskRoute(rawText);
    if (!routed) {
      return null;
    }

    const job = await this.enqueueLongTaskJob(sessionId, {
      taskType: routed.taskType,
      query: routed.query,
      provider: routed.provider,
      authSessionId,
      authPreference,
      reason: routed.reason
    });

    return {
      jobId: job.id,
      taskType: routed.taskType,
      reason: routed.reason,
      response: `This looks like a longer task, so I queued it as job ${job.id}. I’ll post progress updates here.`
    };
  }

  private detectLongTaskRoute(rawText: string): RoutedLongTask | null {
    const text = rawText.trim();
    if (!text) {
      return null;
    }
    if (text.startsWith("/")) {
      return null;
    }

    const lower = text.toLowerCase();
    const explicitResearch =
      lower.includes("web search") ||
      lower.includes("research") ||
      lower.includes("compare") ||
      lower.includes("best ") ||
      lower.includes("top ") ||
      lower.includes("give me options") ||
      lower.includes("one at a time");

    if (!explicitResearch) {
      return null;
    }

    if (text.length < 18) {
      return null;
    }

    return {
      taskType: "web_search",
      query: text,
      provider: this.capabilityPolicy.webSearchProvider,
      reason: "heuristic_research_route"
    };
  }

  private looksLikeProgressQuery(rawText: string): boolean {
    const normalized = rawText.trim().toLowerCase();
    const compact = normalized.replace(/[!?.,]+$/g, "");
    if (!normalized) {
      return false;
    }
    if (compact === "status" || compact === "progress" || compact === "update") {
      return true;
    }
    return /(?:what(?:'s| is)?\s+the\s+status|how(?:'s| is)\s+it\s+going|any\s+update|job\s+status)/i.test(normalized);
  }

  private async findLatestActiveJob(sessionId: string): Promise<Awaited<ReturnType<FileBackedQueueStore["listJobs"]>>[number] | null> {
    const jobs = await this.store.listJobs();
    const relevant = jobs.filter((job) => {
      const owner = typeof job.payload.sessionId === "string" ? job.payload.sessionId : "";
      return owner === sessionId && (job.status === "queued" || job.status === "running" || job.status === "cancelling");
    });
    if (relevant.length === 0) {
      return null;
    }
    relevant.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return relevant[0] ?? null;
  }

  private async enqueueLongTaskJob(
    sessionId: string,
    input: {
      taskType: "web_search";
      query: string;
      provider?: WebSearchProvider;
      authSessionId: string;
      authPreference: LlmAuthPreference;
      reason: string;
    }
  ) {
    if (this.pagedResponseStore) {
      await this.pagedResponseStore.clear(sessionId);
    }

    const job = await this.store.createJob({
      type: "stub_task",
      payload: {
        sessionId,
        taskType: input.taskType,
        query: input.query,
        provider: input.provider ?? this.capabilityPolicy.webSearchProvider,
        authSessionId: input.authSessionId,
        authPreference: input.authPreference,
        routeReason: input.reason
      },
      priority: 5
    });

    await this.queueJobNotification(sessionId, job.id, "queued", `Job ${job.id} queued: ${input.taskType}`);
    await this.queueInFlightStatus(sessionId, `Started ${input.taskType} job ${job.id}...`);
    return job;
  }

  private async executeApprovedAction(
    approval: { action: string; payload: Record<string, unknown> },
    channelSessionId: string,
    authSessionId: string,
    authPreference: LlmAuthPreference
  ): Promise<string> {
    if (approval.action === "send_text") {
      const text = String(approval.payload.text ?? "");
      return `Approved action executed: send '${text}'`;
    }
    if (approval.action === "web_search") {
      if (!this.capabilityPolicy.webSearchEnabled) {
        return "Approved action failed: web search is disabled by policy.";
      }
      const query = String(approval.payload.query ?? "").trim();
      const provider = this.normalizeWebSearchProvider(approval.payload.provider);
      const targetAuthSessionId = String(approval.payload.authSessionId ?? authSessionId).trim() || authSessionId;
      const requestedAuthPreference = this.normalizeAuthPreference(approval.payload.authPreference ?? authPreference);
      if (!query) {
        return "Approved action failed: missing web search query.";
      }
      const job = await this.enqueueLongTaskJob(channelSessionId, {
        taskType: "web_search",
        query,
        provider: provider ?? this.capabilityPolicy.webSearchProvider,
        authSessionId: targetAuthSessionId,
        authPreference: requestedAuthPreference,
        reason: "approved_web_search"
      });
      return `Approved action executed: web_search (queued job ${job.id}).`;
    }
    if (approval.action === "file_write") {
      if (!this.capabilityPolicy.fileWriteEnabled) {
        return "Approved action failed: file write is disabled by policy.";
      }
      const relativePath = String(approval.payload.relativePath ?? "").trim();
      const text = String(approval.payload.text ?? "");
      const resolved = this.resolveWorkspacePath(relativePath);
      if (!resolved.ok) {
        return `Approved action failed: ${resolved.error}`;
      }
      const output = await this.executeFileWrite(resolved.absolutePath, text);
      return `Approved action executed: file_write\n${output}`;
    }

    return `Approved action executed: ${approval.action}`;
  }

  private async queueInFlightStatus(sessionId: string, text: string): Promise<void> {
    if (!this.notificationStore) {
      return;
    }
    try {
      await this.notificationStore.enqueue({
        sessionId,
        text,
        status: "running"
      });
    } catch {
      // best-effort progress status only
    }
  }

  private async executeChatTurn(sessionId: string, text: string, authPreference: LlmAuthPreference): Promise<string> {
    const prepared = await this.prepareChatInput(sessionId, text, authPreference);
    if (!this.llmService) {
      return "No model backend is configured. Connect ChatGPT OAuth or set OPENAI_API_KEY.";
    }

    try {
      const result = await this.llmService.generateText(sessionId, prepared.prompt, { authPreference });
      const llmText = result?.text?.trim();
      if (!llmText) {
        return this.noModelResponse(authPreference);
      }

      if (prepared.sources.length === 0) {
        return llmText;
      }

      return `${llmText}\n\nMemory references:\n${prepared.sources.map((source) => `- ${source}`).join("\n")}`;
    } catch (error) {
      return this.humanizeLlmError(error);
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

  private normalizeAuthPreference(raw: unknown): LlmAuthPreference {
    if (typeof raw !== "string") {
      return "auto";
    }
    const value = raw.trim().toLowerCase();
    if (value === "oauth") {
      return "oauth";
    }
    if (value === "api_key") {
      return "api_key";
    }
    return "auto";
  }

  private normalizeWebSearchProvider(raw: unknown): WebSearchProvider | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const value = raw.trim().toLowerCase();
    if (value === "openai" || value === "brave" || value === "perplexity" || value === "auto") {
      return value;
    }
    return undefined;
  }

  private noModelResponse(authPreference: LlmAuthPreference): string {
    if (authPreference === "oauth") {
      return "No OAuth-backed model session is available. Connect ChatGPT OAuth and try again.";
    }
    if (authPreference === "api_key") {
      return "API-key model mode is selected but OPENAI_API_KEY is not configured or unavailable.";
    }
    return "No model response is available. Connect ChatGPT OAuth or configure OPENAI_API_KEY.";
  }

  private humanizeLlmError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const lower = detail.toLowerCase();

    if (lower.includes("timeout")) {
      return "Model request timed out. Please retry.";
    }
    if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("forbidden")) {
      return "Model authentication failed. Reconnect ChatGPT OAuth or verify OPENAI_API_KEY.";
    }
    if (lower.includes("429") || lower.includes("rate")) {
      return "Model rate limit reached. Please wait and retry.";
    }

    return `Model request failed: ${detail}`;
  }

  private async prepareChatInput(
    sessionId: string,
    input: string,
    authPreference: LlmAuthPreference
  ): Promise<{ prompt: string; sources: string[] }> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { prompt: input, sources: [] };
    }

    const providerManagedContext = await this.shouldUseProviderManagedContext(authPreference);
    const historyLines = providerManagedContext ? [] : await this.buildRecentConversationContext(sessionId, trimmed);

    if (!this.memoryService) {
      if (historyLines.length === 0) {
        return { prompt: input, sources: [] };
      }
      const promptWithoutMemory = [
        "You are answering using recent persisted conversation context when relevant.",
        "Recent conversation context (oldest first):",
        historyLines.join("\n"),
        `User message: ${trimmed}`
      ].join("\n\n");
      return { prompt: promptWithoutMemory, sources: [] };
    }

    let results: MemoryResult[] = [];
    try {
      results = await this.memoryService.searchMemory(trimmed, {
        maxResults: 3,
        minScore: 0.05
      });
    } catch {
      return { prompt: input, sources: [] };
    }

    if (results.length === 0 && historyLines.length === 0) {
      return { prompt: input, sources: [] };
    }

    const promptParts = [
      "You are answering with optional memory context.",
      "If memory snippets are relevant, use them and cite source as [path:start:end]."
    ];
    if (historyLines.length > 0) {
      promptParts.push("Recent conversation context (oldest first):");
      promptParts.push(historyLines.join("\n"));
    }
    if (results.length > 0) {
      const snippets = results.map((item, index) => {
        const normalizedSnippet = item.snippet.replace(/\s+/g, " ").trim().slice(0, 320);
        return `[${index + 1}] ${item.source}\n${normalizedSnippet}`;
      });
      promptParts.push("Memory snippets:");
      promptParts.push(snippets.join("\n\n"));
    }
    promptParts.push(`User message: ${trimmed}`);

    const prompt = promptParts.join("\n\n");

    return {
      prompt,
      sources: results.map((item) => item.source)
    };
  }

  private async buildRecentConversationContext(sessionId: string, currentInput: string): Promise<string[]> {
    if (!this.conversationStore) {
      return [];
    }

    let events: Awaited<ReturnType<ConversationStore["listBySession"]>> = [];
    try {
      events = await this.conversationStore.listBySession(sessionId, 40);
    } catch {
      return [];
    }

    if (events.length === 0) {
      return [];
    }

    const normalizedCurrent = currentInput.replace(/\s+/g, " ").trim().toLowerCase();
    let currentInboundSkipped = false;
    const reversed = [...events].reverse();
    const selected: string[] = [];

    for (const event of reversed) {
      if (event.kind !== "chat" && event.kind !== "command") {
        continue;
      }
      if (event.direction !== "inbound" && event.direction !== "outbound") {
        continue;
      }

      const normalizedText = event.text.replace(/\s+/g, " ").trim();
      if (!normalizedText) {
        continue;
      }

      if (!currentInboundSkipped && event.direction === "inbound" && normalizedText.toLowerCase() === normalizedCurrent) {
        currentInboundSkipped = true;
        continue;
      }

      const role = event.direction === "inbound" ? "user" : "assistant";
      selected.push(`${role}: ${normalizedText.slice(0, 280)}`);
      if (selected.length >= 10) {
        break;
      }
    }

    return selected.reverse();
  }

  private requiresApproval(capability: ExternalCapability): boolean {
    if (!this.capabilityPolicy.approvalDefault) {
      return false;
    }
    if (capability === "web_search") {
      return this.capabilityPolicy.webSearchRequireApproval;
    }
    if (capability === "file_write") {
      return this.capabilityPolicy.fileWriteRequireApproval;
    }
    return true;
  }

  private resolveWorkspacePath(relativePath: string): { ok: true; absolutePath: string } | { ok: false; error: string } {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      return { ok: false, error: "Missing file path. Usage: /write notes/file.md your text" };
    }
    if (path.isAbsolute(trimmed)) {
      return { ok: false, error: "Absolute paths are not allowed for /write." };
    }
    if (trimmed.split(/[\\/]/).includes("..")) {
      return { ok: false, error: "Path traversal is not allowed for /write." };
    }

    const absolutePath = path.resolve(this.capabilityPolicy.workspaceDir, trimmed);
    const workspace = this.capabilityPolicy.workspaceDir;
    if (!(absolutePath === workspace || absolutePath.startsWith(`${workspace}${path.sep}`))) {
      return { ok: false, error: "Path escapes workspace policy boundary." };
    }

    if (this.capabilityPolicy.fileWriteNotesOnly) {
      const normalizedRelative = path.relative(workspace, absolutePath).replace(/\\/g, "/");
      const notesRoot = this.capabilityPolicy.fileWriteNotesDir.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!(normalizedRelative === notesRoot || normalizedRelative.startsWith(`${notesRoot}/`))) {
        return {
          ok: false,
          error: `File write is restricted to '${notesRoot}/' by policy.`
        };
      }
    }

    return { ok: true, absolutePath };
  }

  private async executeFileWrite(absolutePath: string, text: string): Promise<string> {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const content = text.endsWith("\n") ? text : `${text}\n`;
    await fs.appendFile(absolutePath, content, "utf8");

    const relativePath = path.relative(this.capabilityPolicy.workspaceDir, absolutePath).replace(/\\/g, "/");
    return `Appended ${content.length} chars to workspace/${relativePath}`;
  }

  private async executeWebSearch(
    authSessionId: string,
    query: string,
    authPreference: LlmAuthPreference = "auto",
    provider: WebSearchProvider = this.capabilityPolicy.webSearchProvider
  ): Promise<string> {
    if (this.webSearchService) {
      try {
        const result = await this.webSearchService.search(query, {
          provider,
          authSessionId,
          authPreference
        });
        if (result?.text?.trim()) {
          return `Web search provider: ${result.provider}\n${result.text.trim()}`;
        }
      } catch (error) {
        return this.humanizeLlmError(error);
      }
    }

    if (!this.llmService) {
      return "No web search provider is currently available. Configure OpenAI/Codex, Brave, or Perplexity.";
    }

    try {
      const prompt = [
        "You are a web research assistant.",
        "Use available web-search/browsing tools if available.",
        "Return concise findings with source links and publication dates when possible.",
        `Query: ${query.trim()}`
      ].join("\n");
      const result = await this.llmService.generateText(authSessionId, prompt, { authPreference });
      const text = result?.text?.trim();
      if (!text) {
        return "No web search result is available for this query.";
      }
      return `Web search provider: openai\n${text}`;
    } catch (error) {
      return this.humanizeLlmError(error);
    }
  }

  private async shouldUseProviderManagedContext(authPreference: LlmAuthPreference): Promise<boolean> {
    if (authPreference === "api_key") {
      return false;
    }

    if (!this.codexAuthService) {
      return false;
    }

    try {
      const status = await this.codexAuthService.readStatus(false);
      return status.connected === true && status.authMode === "chatgpt";
    } catch {
      return false;
    }
  }
}
