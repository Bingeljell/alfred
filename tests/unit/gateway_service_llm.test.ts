import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";
import { IdentityProfileStore } from "../../apps/gateway-orchestrator/src/auth/identity_profile_store";
import { ConversationStore } from "../../apps/gateway-orchestrator/src/builtins/conversation_store";
import { ApprovalStore } from "../../apps/gateway-orchestrator/src/builtins/approval_store";
import { RunLedgerStore } from "../../apps/gateway-orchestrator/src/builtins/run_ledger_store";
import { SupervisorStore } from "../../apps/gateway-orchestrator/src/builtins/supervisor_store";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";

describe("GatewayService llm path", () => {
  it("treats yes/no as normal chat when no pending approval exists", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-implicit-approve-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "normal chat response",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(queueStore, undefined, undefined, undefined, undefined, approvalStore, undefined, llm);
    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });

    expect(chat.response).toContain("normal chat response");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("queues web search command without approval and records tool transparency", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-web-search-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const conversationStore = new ConversationStore(stateDir);
    await conversationStore.ensureReady();

    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Top result: https://platform.openai.com/",
        model: "openai-codex/default",
        authMode: "oauth"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      conversationStore,
      undefined,
      undefined,
      {
        approvalMode: "strict",
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: true
      }
    );

    const queuedResponse = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/web latest OpenAI OAuth docs",
      requestJob: false
    });
    expect(queuedResponse.response).toContain("Queued web search as job");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    const queued = jobs[0];
    expect(queued?.status).toBe("queued");
    expect(queued?.payload?.taskType).toBe("web_search");
    expect(queued?.payload?.query).toBe("latest OpenAI OAuth docs");
    const conversationEvents = await conversationStore.listBySession("owner@s.whatsapp.net", 20);
    const toolEvent = conversationEvents.find((event) => event.direction === "system" && event.text.includes("Tool used: web.search"));
    expect(toolEvent).toBeTruthy();
    expect(toolEvent?.metadata?.toolUsage).toBe(true);

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(0);
  });

  it("shows pending approvals and resolves with slash token commands", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-approval-pending-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const service = new GatewayService(queueStore, undefined, undefined, undefined, undefined, approvalStore);
    const gated = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "send hello from approval test",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required");

    const pending = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/approval pending",
      requestJob: false
    });
    expect(pending.response).toContain("Pending approvals");
    expect(pending.response).toContain("send_text");

    const token = String(gated.response?.split("approve ")[1] ?? "").trim();
    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/approve ${token}`,
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: send 'hello from approval test'");
  });

  it("creates supervised fan-out web jobs and exposes supervisor status", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-supervisor-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const supervisorStore = new SupervisorStore(stateDir);
    await supervisorStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: false
      },
      undefined,
      undefined,
      undefined,
      undefined,
      supervisorStore
    );

    const created = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/supervise web --providers=openai,brave compare stable diffusion options",
      requestJob: false
    });
    expect(created.response).toContain("Supervisor");
    expect(created.response).toContain("queued 2 child jobs");
    const supervisorId = created.response?.match(/Supervisor\s+([^\s]+)\s+queued/i)?.[1] ?? "";
    expect(supervisorId).toBeTruthy();

    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(2);
    const supervisorIds = new Set(jobs.map((job) => String(job.payload.supervisorId ?? "")));
    expect(supervisorIds.size).toBe(1);
    expect([...supervisorIds][0]).toBe(supervisorId);

    const status = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/supervisor status ${supervisorId}`,
      requestJob: false
    });
    expect(status.response).toContain(`Supervisor ${supervisorId}`);
    expect(status.response).toContain("status=running");
  });

  it("queues web search command for worker with immediate status updates", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-web-progress-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const notifications = {
      enqueue: vi.fn().mockResolvedValue({ id: "n1" })
    };

    const service = new GatewayService(
      queueStore,
      notifications as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: false
      }
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/web --provider=brave latest openai news",
      requestJob: false
    });

    expect(result.response).toContain("Queued web search as job");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    const queued = jobs[0];
    expect(queued?.status).toBe("queued");
    expect(queued?.payload?.provider).toBe("brave");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("routes research-style long requests to worker and answers progress queries", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-long-task-route-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const notifications = {
      enqueue: vi.fn().mockResolvedValue({ id: "n1" })
    };

    const service = new GatewayService(
      queueStore,
      notifications as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: false
      }
    );

    const routed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Can you research the best stable diffusion models and compare top options one at a time?",
      requestJob: false
    });

    expect(routed.mode).toBe("async-job");
    expect(routed.response).toContain("queued it as job");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job?.payload?.taskType).toBe("agentic_turn");

    const status = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "status?",
      requestJob: false
    });
    expect(status.response).toContain(`Latest job ${job?.id} is queued`);
  });

  it("requests approval for heuristic research-to-file routing when side effects are required", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-heuristic-web-to-file-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: true
      },
      undefined,
      undefined,
      undefined
    );

    const routed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "research best stable diffusion models and send me a markdown document",
      requestJob: false
    });

    expect(routed.mode).toBe("chat");
    expect(routed.response).toContain("Approval required for step 'Write File'");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(0);
  });

  it("emits a planner trace event with chosen action metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-trace-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const conversationStore = new ConversationStore(stateDir);
    await conversationStore.ensureReady();
    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "web_research",
        confidence: 0.87,
        needsWorker: true,
        query: "research best stable diffusion models",
        provider: "brave",
        reason: "unit_test_planner"
      })
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      conversationStore,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: false
      },
      undefined,
      undefined,
      planner as never,
      undefined
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Research best stable diffusion models",
      requestJob: false
    });
    expect(result.mode).toBe("async-job");

    const events = await conversationStore.query({
      sessionId: "owner@s.whatsapp.net",
      kinds: ["command"],
      directions: ["system"],
      limit: 40
    });
    const traces = events.filter((event) => event.metadata?.plannerTrace === true);
    expect(traces.length).toBe(1);
    const trace = traces[0];
    expect(trace?.text).toContain("Planner selected web_research");
    expect(trace?.metadata?.plannerIntent).toBe("web_research");
    expect(trace?.metadata?.plannerChosenAction).toBe("enqueue_worker_agentic_turn");
    expect(trace?.metadata?.plannerReason).toBe("unit_test_planner");
    expect(trace?.metadata?.plannerNeedsWorker).toBe(true);
  });

  it("routes planner attachment requests through approval then queues web_to_file job", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-attachment-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const notificationStore = new OutboundNotificationStore(stateDir);
    await notificationStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const planner = {
      plan: vi.fn().mockImplementation(async (_sessionId: string, message: string) => {
        if (message.toLowerCase().startsWith("approve ") || message.toLowerCase().startsWith("/approve ")) {
          return {
            intent: "command",
            confidence: 1,
            needsWorker: false,
            reason: "explicit_command"
          };
        }
        return {
          intent: "web_research",
          confidence: 0.91,
          needsWorker: true,
          query: "best stable diffusion models",
          provider: "searxng",
          sendAttachment: true,
          fileFormat: "md",
          fileName: "sd_models_report",
          reason: "attachment_requested"
        };
      })
    };

    const service = new GatewayService(
      queueStore,
      notificationStore,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: true
      },
      undefined,
      undefined,
      planner as never
    );

    const gated = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Please research best stable diffusion models and send me a markdown file",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required for step 'Write File'");

    const firstToken = String(gated.response?.split("approve ")[1] ?? "").trim();
    const firstApproval = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `approve ${firstToken}`,
      requestJob: false
    });
    expect(firstApproval.response).toContain("Step 'write' approved. Run queued as job");

    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.payload?.taskType).toBe("run_spec");
    const approvedRunSpec = jobs[0]?.payload?.runSpec as
      | { steps?: Array<{ input?: { fileFormat?: string } }> }
      | undefined;
    expect(approvedRunSpec?.steps?.[2]?.input?.fileFormat).toBe("md");
  });

  it("resolves yes/no approvals before planner clarification", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-implicit-approval-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();
    await approvalStore.create("owner@s.whatsapp.net", "send_text", { text: "hello world" });

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "clarify",
        confidence: 0.2,
        needsWorker: false,
        question: "Could you confirm what you want me to do next?",
        reason: "forced_clarify_for_test"
      })
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      planner as never
    );

    const response = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(response.response).toContain("Approved action executed: send 'hello world'");
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it("queues planner attachment request directly when approval is not required", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-attachment-direct-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "web_research",
        confidence: 0.88,
        needsWorker: true,
        query: "compare note taking apps",
        provider: "searxng",
        sendAttachment: true,
        fileFormat: "txt",
        reason: "attachment_direct"
      })
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalMode: "relaxed",
        approvalDefault: false,
        webSearchEnabled: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: false
      },
      undefined,
      undefined,
      planner as never
    );

    const routed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Research note taking apps and send me a txt file",
      requestJob: false
    });
    expect(routed.mode).toBe("async-job");
    expect(routed.response).toContain("research + document delivery");

    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.payload?.taskType).toBe("run_spec");
    const directRunSpec = jobs[0]?.payload?.runSpec as
      | { steps?: Array<{ input?: { fileFormat?: string } }> }
      | undefined;
    expect(directRunSpec?.steps?.[2]?.input?.fileFormat).toBe("txt");
  });

  it("delegates command-intent plans to worker when planner marks needsWorker", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-command-worker-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "fallback-chat"
      })
    };

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "command",
        confidence: 0.91,
        needsWorker: true,
        query: "Retry the previous web research comparison task using searxng.",
        provider: "searxng",
        sendAttachment: false,
        reason: "retry_requested"
      })
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm as never,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true
      },
      undefined,
      undefined,
      planner as never
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Try again please",
      requestJob: false
    });

    expect(result.mode).toBe("async-job");
    expect(result.response).toContain("Queued research as job");

    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.payload?.taskType).toBe("agentic_turn");
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("serves #next pages from paged response store", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-next-page-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const pagedStore = {
      popNext: vi
        .fn()
        .mockResolvedValueOnce({ page: "Page 2 content", remaining: 1 })
        .mockResolvedValueOnce({ page: "Page 3 content", remaining: 0 }),
      clear: vi.fn().mockResolvedValue(undefined)
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pagedStore
    );

    const first = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "#next",
      requestJob: false
    });
    expect(first.response).toContain("Page 2 content");
    expect(first.response).toContain("Reply #next for more (1 remaining)");

    const second = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "next",
      requestJob: false
    });
    expect(second.response).toContain("Page 3 content");
    expect(second.response).not.toContain("remaining");
  });

  it("enforces file-write policy with notes-only workspace scope", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-write-policy-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const disabledService = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore
    );

    const disabled = await disabledService.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/write notes/day.md hello",
      requestJob: false
    });
    expect(disabled.response).toContain("File write is disabled by policy");

    const enabledService = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalDefault: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: true,
        fileWriteNotesOnly: true,
        fileWriteNotesDir: "notes"
      }
    );

    const blocked = await enabledService.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/write todo.md this should fail",
      requestJob: false
    });
    expect(blocked.response).toContain("restricted to 'notes/'");

    const gated = await enabledService.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/write notes/day.md write this line",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required for file write");

    const token = String(gated.response?.split("approve ")[1] ?? "").trim();
    const approved = await enabledService.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `approve ${token}`,
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: file_write");
    expect(approved.response).toContain("workspace/notes/day.md");

    const written = await fs.readFile(path.join(workspaceDir, "notes", "day.md"), "utf8");
    expect(written).toContain("write this line");
  });

  it("queues approved file attachment sends for whatsapp delivery", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-file-send-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const notificationStore = new OutboundNotificationStore(stateDir);
    await notificationStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    await fs.mkdir(path.join(workspaceDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "notes", "summary.md"), "# Summary\n", "utf8");

    const service = new GatewayService(
      queueStore,
      notificationStore,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalDefault: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: true,
        fileWriteNotesOnly: true,
        fileWriteNotesDir: "notes"
      }
    );

    const gated = await service.handleInbound({
      sessionId: "919819874144@s.whatsapp.net",
      text: "/file send notes/summary.md daily update",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required for file send");

    const token = String(gated.response?.split("approve ")[1] ?? "").trim();
    const approved = await service.handleInbound({
      sessionId: "919819874144@s.whatsapp.net",
      text: `approve ${token}`,
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: file_send");

    const pending = await notificationStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("file");
    expect(pending[0]?.fileName).toBe("summary.md");
    expect(pending[0]?.caption).toBe("daily update");
  });

  it("routes natural-language local ops to approval-gated shell execution", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-local-ops-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          needsClarification: false,
          question: "",
          command: "echo searxng_ok",
          cwd: workspaceDir,
          reason: "restart_local_service",
          confidence: 0.91
        }),
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalMode: "relaxed",
        approvalDefault: false,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Please restart the searxng server in the local workspace",
      requestJob: false
    });
    expect(proposed.mode).toBe("chat");
    expect(proposed.response).toContain("Local operation ready for approval.");
    expect(proposed.response).toContain("echo searxng_ok");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: shell_exec");
    expect(approved.response).toContain("searxng_ok");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[1] ?? "")).toContain("local-ops planner");
    expect(calls[0]?.[2]).toEqual({ authPreference: "auto", executionMode: "reasoning_only" });
  });

  it("rejects shell command cwd outside allowlisted directories", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-shell-scope-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalMode: "relaxed",
        approvalDefault: false,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const blocked = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/shell --cwd=/tmp pwd",
      requestJob: false
    });
    expect(blocked.mode).toBe("chat");
    expect(blocked.response).toContain("outside allowed scope");
  });

  it("uses llm response for regular chat and preserves command routing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Model says hello",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm
    );

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "hello there",
      requestJob: false
    });
    expect(chat.response).toBe("Model says hello");

    const command = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/auth status",
      requestJob: false
    });
    expect(command.response).toContain("OAuth is not configured");
    expect((llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
  });

  it("falls back to ack when llm is unavailable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-fallback-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue(null)
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm
    );

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "fallback please",
      requestJob: false
    });

    expect(chat.response).toContain("No model response is available");
  });

  it("routes WhatsApp chat turns through mapped auth session id", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-map-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const identityStore = new IdentityProfileStore(stateDir);
    await identityStore.ensureReady();
    await identityStore.setMapping("12345@s.whatsapp.net", "auth-profile-1");

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Mapped profile response",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      identityStore
    );

    const chat = await service.handleInbound({
      sessionId: "12345@s.whatsapp.net",
      text: "hello from whatsapp",
      requestJob: false,
      metadata: { provider: "baileys" }
    });
    expect(chat.response).toBe("Mapped profile response");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("auth-profile-1");
  });

  it("injects memory snippets into prompt and appends memory references", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-memory-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Here is what I found.",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const memory = {
      searchMemory: vi.fn().mockResolvedValue([
        {
          path: "memory/2026-02-23.md",
          startLine: 10,
          endLine: 14,
          score: 0.81,
          snippet: "User prefers strict /alfred prefix on WhatsApp.",
          source: "memory/2026-02-23.md:10:14"
        }
      ])
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      memory as never
    );

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "what prefix did we choose?",
      requestJob: false
    });
    expect(chat.response).toContain("Here is what I found.");
    expect(chat.response).toContain("Memory references:");
    expect(chat.response).toContain("[preference]");
    expect(chat.response).toContain("memory/2026-02-23.md:10:14");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[1] ?? "")).toContain("Memory snippets:");
    expect(String(calls[0]?.[1] ?? "")).toContain("[preference]");
    expect(String(calls[0]?.[1] ?? "")).toContain("memory/2026-02-23.md:10:14");
  });

  it("filters memory snippets by requested class for decision queries", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-memory-class-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Decision context applied.",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const memory = {
      searchMemory: vi.fn().mockResolvedValue([
        {
          path: "memory/2026-02-25.md",
          startLine: 5,
          endLine: 8,
          score: 0.91,
          snippet: "[memory-checkpoint] class: decision summary: Approved web search action",
          source: "memory/2026-02-25.md:5:8"
        },
        {
          path: "memory/2026-02-25.md",
          startLine: 20,
          endLine: 23,
          score: 0.84,
          snippet: "[memory-checkpoint] class: preference summary: User prefers concise answers",
          source: "memory/2026-02-25.md:20:23"
        }
      ])
    };

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      memory as never
    );

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "What decision did we make about approval mode?",
      requestJob: false
    });
    expect(chat.response).toContain("[decision]");
    expect(chat.response).not.toContain("[preference]");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]?.[1] ?? "")).toContain("Requested memory classes: decision");
    expect(String(calls[0]?.[1] ?? "")).toContain("[decision]");
    expect(String(calls[0]?.[1] ?? "")).not.toContain("[preference]");
  });

  it("forwards requested auth preference to llm service", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-pref-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "preference checked",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm
    );

    await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "hello",
      requestJob: false,
      metadata: { authPreference: "api_key" }
    });

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[2]).toEqual({ authPreference: "api_key", executionMode: "reasoning_only" });
  });

  it("records run-ledger phases for a successful chat turn", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-run-ledger-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const runLedger = new RunLedgerStore(stateDir);
    await runLedger.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "run ledger response",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runLedger
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "hello run ledger",
      requestJob: false,
      metadata: {
        idempotencyKey: "run-ledger-key-1"
      }
    });
    expect(result.response).toContain("run ledger response");

    const runs = await runLedger.listRuns({ sessionKey: "owner@s.whatsapp.net", limit: 5 });
    expect(runs.length).toBeGreaterThan(0);
    const run = runs[0];
    expect(run?.status).toBe("completed");
    expect(run?.spec.idempotencyKey).toBe("run-ledger-key-1");
    const phases = new Set(run?.events.filter((event) => event.type === "phase").map((event) => event.phase));
    expect(phases.has("session")).toBe(true);
    expect(phases.has("directives")).toBe(true);
    expect(phases.has("route")).toBe(true);
    expect(phases.has("persist")).toBe(true);
    expect(run?.events.some((event) => event.type === "completed")).toBe(true);
  });

  it("injects recent persisted conversation context into prompt", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-history-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const events = [
      {
        sessionId: "owner@s.whatsapp.net",
        direction: "inbound",
        text: "remember we chose strict prefix",
        kind: "chat"
      },
      {
        sessionId: "owner@s.whatsapp.net",
        direction: "outbound",
        text: "Yes, /alfred is required.",
        kind: "chat"
      }
    ] as Array<{ sessionId: string; direction: "inbound" | "outbound"; text: string; kind: "chat" }>;

    const conversationStore = {
      add: vi.fn(async (sessionId: string, direction: "inbound" | "outbound" | "system", text: string) => {
        if (direction === "inbound" || direction === "outbound") {
          events.push({ sessionId, direction, text, kind: "chat" });
        }
        return { id: "x" };
      }),
      listBySession: vi.fn(async (sessionId: string) =>
        events
          .filter((item) => item.sessionId === sessionId)
          .map((item, index) => ({
            id: String(index),
            sessionId: item.sessionId,
            direction: item.direction,
            text: item.text,
            source: "gateway",
            channel: "direct",
            kind: item.kind,
            createdAt: new Date().toISOString()
          }))
      )
    } as unknown as ConversationStore;

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "Context-aware reply",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      undefined,
      "chatgpt",
      undefined,
      conversationStore
    );

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "what prefix is enabled now?",
      requestJob: false
    });
    expect(chat.response).toContain("Context-aware reply");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const prompt = String(calls[0]?.[1] ?? "");
    expect(prompt).toContain("Recent conversation context");
    expect(prompt).toContain("assistant: Yes, /alfred is required.");
  });

  it("skips transcript context injection when codex provider context is active", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-codex-context-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const conversationStore = {
      add: vi.fn(async () => ({ id: "x" })),
      listBySession: vi.fn(async () => [
        {
          id: "1",
          sessionId: "owner@s.whatsapp.net",
          direction: "inbound",
          text: "old user line",
          source: "gateway",
          channel: "direct",
          kind: "chat",
          createdAt: new Date().toISOString()
        },
        {
          id: "2",
          sessionId: "owner@s.whatsapp.net",
          direction: "outbound",
          text: "old assistant line",
          source: "gateway",
          channel: "direct",
          kind: "chat",
          createdAt: new Date().toISOString()
        }
      ])
    } as unknown as ConversationStore;

    const codexAuth = {
      readStatus: vi.fn().mockResolvedValue({
        connected: true,
        authMode: "chatgpt"
      })
    };

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "codex-context-aware",
        model: "openai-codex/default",
        authMode: "oauth"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      codexAuth as never,
      "chatgpt",
      undefined,
      conversationStore
    );

    await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "new question",
      requestJob: false
    });

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toBe("new question");
    expect(calls[0]?.[2]).toEqual({ authPreference: "auto", executionMode: "reasoning_only" });
  });

  it("still injects transcript context when api_key mode is forced", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-llm-api-context-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const conversationStore = {
      add: vi.fn(async () => ({ id: "x" })),
      listBySession: vi.fn(async () => [
        {
          id: "1",
          sessionId: "owner@s.whatsapp.net",
          direction: "inbound",
          text: "prior user detail",
          source: "gateway",
          channel: "direct",
          kind: "chat",
          createdAt: new Date().toISOString()
        },
        {
          id: "2",
          sessionId: "owner@s.whatsapp.net",
          direction: "outbound",
          text: "prior assistant detail",
          source: "gateway",
          channel: "direct",
          kind: "chat",
          createdAt: new Date().toISOString()
        }
      ])
    } as unknown as ConversationStore;

    const codexAuth = {
      readStatus: vi.fn().mockResolvedValue({
        connected: true,
        authMode: "chatgpt"
      })
    };

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "api-context-aware",
        model: "gpt-4.1-mini",
        authMode: "api_key"
      })
    } as unknown as OpenAIResponsesService;

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      llm,
      codexAuth as never,
      "chatgpt",
      undefined,
      conversationStore
    );

    await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "new api question",
      requestJob: false,
      metadata: { authPreference: "api_key" }
    });

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[1] ?? "")).toContain("Recent conversation context");
    expect(String(calls[0]?.[1] ?? "")).toContain("assistant: prior assistant detail");
    expect(calls[0]?.[2]).toEqual({ authPreference: "api_key", executionMode: "reasoning_only" });
  });

  it("grants file-write approval once per auth session when configured", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-write-session-lease-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalDefault: true,
        fileWriteEnabled: true,
        fileWriteRequireApproval: true,
        fileWriteNotesOnly: true,
        fileWriteNotesDir: "notes",
        fileWriteApprovalMode: "session",
        fileWriteApprovalScope: "auth"
      }
    );

    const first = await service.handleInbound({
      sessionId: "channel-a@lid",
      text: "/write notes/day.md first line",
      requestJob: false,
      metadata: {
        authSessionId: "wa-user"
      }
    });
    expect(first.response).toContain("Approval required for file write");

    const token = String(first.response?.split("approve ")[1] ?? "").trim();
    const approved = await service.handleInbound({
      sessionId: "channel-a@lid",
      text: `approve ${token}`,
      requestJob: false,
      metadata: {
        authSessionId: "wa-user"
      }
    });
    expect(approved.response).toContain("Approved action executed: file_write");

    const second = await service.handleInbound({
      sessionId: "channel-a@lid",
      text: "/write notes/day.md second line",
      requestJob: false,
      metadata: {
        authSessionId: "wa-user"
      }
    });
    expect(second.response).toContain("Appended");
    expect(second.response).not.toContain("Approval required");
  });

  it("blocks risky shell commands and supports explicit override token flow", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-shell-policy-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const service = new GatewayService(
      queueStore,
      undefined,
      undefined,
      undefined,
      undefined,
      approvalStore,
      undefined,
      undefined,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        shellEnabled: true,
        shellTimeoutMs: 5000,
        shellMaxOutputChars: 2000
      }
    );

    const blocked = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/shell sudo echo hi",
      requestJob: false
    });
    expect(blocked.response).toContain("Shell command blocked by policy");
    expect(blocked.response).toContain("approve shell");

    const token = blocked.response?.match(/approve shell ([^\s]+)/i)?.[1] ?? "";
    expect(token).toBeTruthy();

    const overridden = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `approve shell ${token}`,
      requestJob: false
    });
    expect(overridden.response).toContain("Approved risky shell override");
    expect(String(overridden.response)).toMatch(/Shell run in workspace|Shell failed to start/);
  });
});
