import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

  it("treats natural approval phrases as approve_latest when a pending action exists", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-implicit-approval-phrase-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const service = new GatewayService(queueStore, undefined, undefined, undefined, undefined, approvalStore);
    const gated = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "send hello from phrase approval",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "Approve search - do a general search",
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: send 'hello from phrase approval'");
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
    expect(trace?.text).toContain("Planner hint web_research");
    expect(trace?.metadata?.plannerIntent).toBe("web_research");
    expect(trace?.metadata?.plannerChosenAction).toBe("enqueue_heuristic_long_task");
    expect(trace?.metadata?.plannerReason).toBe("unit_test_planner");
    expect(trace?.metadata?.plannerNeedsWorker).toBe(true);
    expect(trace?.metadata?.plannerWillDelegateWorker).toBe(true);
    expect(trace?.metadata?.plannerForcedWorkerDelegation).toBe(false);
    expect(trace?.metadata?.plannerDelegationReason).toBe("planner_requested_worker");
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
    expect(routed.response).toContain("research + file delivery");

    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.payload?.taskType).toBe("run_spec");
    const directRunSpec = jobs[0]?.payload?.runSpec as
      | { steps?: Array<{ input?: { fileFormat?: string } }> }
      | undefined;
    expect(directRunSpec?.steps?.[2]?.input?.fileFormat).toBe("txt");
  });

  it("treats command-intent planner output as advisory and still runs chat turn", async () => {
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

    expect(result.mode).toBe("chat");
    expect(result.response).toContain("fallback-chat");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(0);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("does not force worker delegation from planner web_research hints alone", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-force-web-worker-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "fallback-chat"
      })
    };

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "web_research",
        confidence: 0.93,
        needsWorker: false,
        query: "quick search on middle east news right now",
        provider: "searxng",
        sendAttachment: false,
        reason: "unit_test_web_research_without_needs_worker"
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
      text: "Hey Alfred, can you do a quick search of what's happening in the middle east right now",
      requestJob: false
    });

    expect(result.mode).toBe("chat");
    expect(result.response).toContain("fallback-chat");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(0);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("does not force attachment worker delegation from planner hints alone", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-force-attachment-worker-unit-"));
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
        confidence: 0.9,
        needsWorker: false,
        query: "prepare and send a markdown summary of latest middle east updates",
        provider: "searxng",
        sendAttachment: true,
        fileFormat: "md",
        reason: "unit_test_attachment_without_needs_worker"
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

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "prepare and send a markdown summary of latest middle east updates",
      requestJob: false
    });

    expect(result.mode).toBe("chat");
    expect(result.response).toContain("fallback-chat");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(0);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("routes planner command+needsWorker local ops to approval-gated shell path instead of research worker", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-localops-precedence-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          assistant_response: "I can run that local operation after approval.",
          next_action: {
            type: "shell.exec",
            command: "echo searxng_started",
            cwd: workspaceDir,
            reason: "start_local_service"
          }
        })
      })
    };

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "command",
        confidence: 0.93,
        needsWorker: true,
        query: "Start the SearXNG service by checking setup in /projects/searxng and bringing it up.",
        provider: "auto",
        reason: "local_ops_request"
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
      llm as never,
      undefined,
      "chatgpt",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaceDir,
        approvalMode: "balanced",
        approvalDefault: true,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      },
      undefined,
      undefined,
      planner as never
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "OH the fetch failed because the SearXNG service is off, can you start it from /projects/searxng?",
      requestJob: false
    });

    expect(result.mode).toBe("chat");
    expect(result.response).toContain("Shell operation ready for approval.");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(0);
  });

  it("treats planner status_query as advisory and allows chat turn execution", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-planner-status-intent-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "this should not be used"
      })
    };

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "status_query",
        confidence: 0.96,
        needsWorker: false,
        reason: "unit_test_status_query"
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
      undefined,
      undefined,
      undefined,
      planner as never
    );

    const result = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "so are you doing anything?",
      requestJob: false
    });
    expect(result.mode).toBe("chat");
    expect(result.response).toBe("this should not be used");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("provides execution policy preview for debugging delegation decisions", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-exec-policy-preview-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const planner = {
      plan: vi.fn().mockResolvedValue({
        intent: "web_research",
        confidence: 0.94,
        needsWorker: false,
        query: "latest middle east updates",
        provider: "searxng",
        sendAttachment: false,
        reason: "unit_test_preview"
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
      undefined,
      undefined,
      undefined,
      planner as never
    );

    const preview = await service.previewExecutionPolicy({
      sessionId: "owner@s.whatsapp.net",
      text: "Hey Alfred, can you do a quick search of what's happening in the middle east right now"
    });

    expect(preview.plannerDecision?.intent).toBe("web_research");
    expect(preview.delegation.willDelegateWorker).toBe(true);
    expect(preview.delegation.forcedByPolicy).toBe(true);
    expect(preview.predictedRoute).toBe("worker_agentic_turn");
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
          assistant_response: "I can restart that now.",
          next_action: {
            type: "shell.exec",
            command: "echo searxng_ok",
            cwd: workspaceDir,
            reason: "restart_local_service"
          }
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
    expect(proposed.response).toContain("Shell operation ready for approval.");
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
    expect(String(calls[0]?.[1] ?? "")).toContain("goal-oriented orchestrator");
    expect(calls[0]?.[2]).toEqual({ authPreference: "auto" });
  });

  it("reruns latest failed search query after approved local shell recovery action", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-local-ops-rerun-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const failed = await queueStore.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "current EPL top 10 standings"
      },
      priority: 5
    });
    await queueStore.failJob(failed.id, {
      code: "web_search_no_results",
      message: "fetch failed"
    });

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          assistant_response: "I can recover the search backend now.",
          next_action: {
            type: "shell.exec",
            command: "echo searxng_started",
            cwd: workspaceDir,
            reason: "recover_search"
          }
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
        approvalMode: "balanced",
        approvalDefault: true,
        webSearchEnabled: true,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "searxng is down, please start the local service and rerun my last search",
      requestJob: false
    });
    expect(proposed.response).toContain("Shell operation ready for approval.");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: shell_exec");
    expect(approved.response).toContain("Rerunning prior task as job");

    const jobs = await queueStore.listJobs();
    const rerun = jobs.filter(
      (job) =>
        job.status === "queued" &&
        String(job.payload.sessionId ?? "") === "owner@s.whatsapp.net" &&
        String(job.payload.query ?? "") === "current EPL top 10 standings"
    );
    expect(rerun.length).toBe(1);
  });

  it("does not rerun search when approved shell recovery command exits non-zero", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-local-ops-rerun-fail-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const failed = await queueStore.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "latest middle east headlines"
      },
      priority: 5
    });
    await queueStore.failJob(failed.id, {
      code: "web_search_no_results",
      message: "fetch failed"
    });

    const llm = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            assistant_response: "I can bring the search service back first.",
            next_action: {
              type: "shell.exec",
              command: "exit 1",
              cwd: workspaceDir,
              reason: "recover_search"
            }
          }),
          model: "gpt-4.1-mini",
          authMode: "api_key"
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            assistant_response: "I hit a shell failure. Should I retry using your searx Python venv activation first?",
            next_action: {
              type: "ask_user",
              reason: "need_runtime_details"
            }
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
        approvalMode: "balanced",
        approvalDefault: true,
        webSearchEnabled: true,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "search is down, restart local searxng",
      requestJob: false
    });
    expect(proposed.response).toContain("Shell operation ready for approval.");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: shell_exec");
    expect(approved.response).toContain("exit_code=1");
    expect(approved.response).toContain("Should I retry using your searx Python venv activation first?");

    const jobs = await queueStore.listJobs();
    const rerun = jobs.filter(
      (job) =>
        job.status === "queued" &&
        String(job.payload.sessionId ?? "") === "owner@s.whatsapp.net" &&
        String(job.payload.query ?? "") === "latest middle east headlines"
    );
    expect(rerun.length).toBe(0);
  });

  it("proposes a new approved shell step after failed shell recovery execution", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-local-ops-replan-shell-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const failed = await queueStore.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "latest EPL top 10 standings"
      },
      priority: 5
    });
    await queueStore.failJob(failed.id, {
      code: "web_search_no_results",
      message: "fetch failed"
    });

    const llm = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            assistant_response: "I can recover search first.",
            next_action: {
              type: "shell.exec",
              command: "exit 1",
              cwd: workspaceDir,
              reason: "recover_search"
            }
          }),
          model: "gpt-4.1-mini",
          authMode: "api_key"
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            assistant_response: "I can retry using a venv-based startup command.",
            next_action: {
              type: "shell.exec",
              command: "source searx-pyenv/bin/activate && SEARXNG_SETTINGS_PATH=local/settings.yml python3.13 -m searx.webapp",
              cwd: workspaceDir,
              rerunQuery: "latest EPL top 10 standings",
              reason: "retry_with_venv"
            }
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
        approvalMode: "balanced",
        approvalDefault: true,
        webSearchEnabled: true,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "restart local searxng and rerun search",
      requestJob: false
    });
    expect(proposed.response).toContain("Shell operation ready for approval.");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: shell_exec");
    expect(approved.response).toContain("I can retry using a venv-based startup command.");
    expect(approved.response).toContain("Shell operation ready for approval.");
    expect(approved.response).toContain("source searx-pyenv/bin/activate");
  });

  it("reruns the latest recoverable query when most recent search ended with no context", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-local-ops-rerun-latest-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const olderFailed = await queueStore.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "research best stable diffusion models"
      },
      priority: 5
    });
    await queueStore.failJob(olderFailed.id, {
      code: "web_search_no_results",
      message: "fetch failed"
    });

    const latestNoContext = await queueStore.createJob({
      type: "stub_task",
      payload: {
        sessionId: "owner@s.whatsapp.net",
        taskType: "agentic_turn",
        query: "current EPL top 10 standings"
      },
      priority: 5
    });
    await queueStore.completeJob(latestNoContext.id, {
      summary: "agentic_turn_no_context",
      responseText: "I couldn't gather web context for this request. Reason: fetch failed"
    });

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          assistant_response: "I'll recover search and rerun your latest request.",
          next_action: {
            type: "shell.exec",
            command: "echo searxng_started",
            cwd: workspaceDir,
            reason: "recover_search"
          }
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
        approvalMode: "balanced",
        approvalDefault: true,
        webSearchEnabled: true,
        shellEnabled: true,
        shellAllowedDirs: [workspaceDir]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "bring searxng back and rerun my last failed search",
      requestJob: false
    });
    expect(proposed.response).toContain("Shell operation ready for approval.");

    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "yes",
      requestJob: false
    });
    expect(approved.response).toContain("Rerunning prior task as job");

    const jobs = await queueStore.listJobs();
    const rerun = jobs.filter(
      (job) =>
        job.status === "queued" &&
        String(job.payload.sessionId ?? "") === "owner@s.whatsapp.net" &&
        String(job.payload.query ?? "") === "current EPL top 10 standings"
    );
    expect(rerun.length).toBe(1);
  });

  it("accepts local-ops cwd when allowlisted root is a symlink to the same directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-shell-symlink-scope-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const realAllowedRoot = path.join(stateDir, "external", "searxng");
    await fs.mkdir(realAllowedRoot, { recursive: true });
    const symlinkAllowedRoot = path.join(stateDir, "external", "searxng-link");
    await fs.symlink(realAllowedRoot, symlinkAllowedRoot);

    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          assistant_response: "I'll start the local service after approval.",
          next_action: {
            type: "shell.exec",
            command: "python -m searx.webapp",
            cwd: realAllowedRoot,
            reason: "start_local_service"
          }
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
        shellAllowedDirs: [symlinkAllowedRoot]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "start the local searxng server in my project folder",
      requestJob: false
    });
    expect(proposed.mode).toBe("chat");
    expect(proposed.response).toContain("Shell operation ready for approval.");
    expect(proposed.response).toContain("python -m searx.webapp");
  });

  it("handles local-ops cwd case variance on case-insensitive platforms", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-shell-case-scope-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const allowedRoot = path.join(stateDir, "projects", "searxng");
    await fs.mkdir(allowedRoot, { recursive: true });
    const mixedCaseCwd = allowedRoot.replace(/searxng$/, "searXNG");

    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();
    const approvalStore = new ApprovalStore(stateDir);
    await approvalStore.ensureReady();

    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          assistant_response: "I'll run that service startup command.",
          next_action: {
            type: "shell.exec",
            command: "python -m searx.webapp",
            cwd: mixedCaseCwd,
            reason: "start_local_service"
          }
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
        shellAllowedDirs: [allowedRoot]
      }
    );

    const proposed = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "start searxng from local project folder",
      requestJob: false
    });

    if (process.platform === "darwin" || process.platform === "win32") {
      expect(proposed.response).toContain("Shell operation ready for approval.");
    } else {
      expect(proposed.response).toContain("outside allowed scope");
    }
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

  it("supports file read and hash-guarded file edit within allowlisted roots", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-file-read-edit-unit-"));
    const workspaceDir = path.join(stateDir, "workspace", "alfred");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sharedDir = path.join(stateDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    const targetFile = path.join(sharedDir, "sample.txt");
    await fs.writeFile(targetFile, "line one\nline two\nline three\n", "utf8");
    const originalHash = createHash("sha256").update("line one\nline two\nline three\n").digest("hex");

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
        fileReadEnabled: true,
        fileReadAllowedDirs: [sharedDir],
        fileWriteEnabled: true,
        fileWriteRequireApproval: false,
        fileWriteNotesOnly: false,
        fileEditEnabled: true,
        fileEditRequireApproval: false,
        fileEditAllowedDirs: [sharedDir]
      }
    );

    const read = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/file read ${targetFile} --from=2 --lines=2`,
      requestJob: false
    });
    expect(read.response).toContain("SHA256:");
    expect(read.response).toContain("2| line two");
    expect(read.response).toContain("3| line three");

    const wrongHashEdit = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/file edit ${targetFile} --find="line two" --replace="line 2" --hash=${"f".repeat(64)}`,
      requestJob: false
    });
    expect(wrongHashEdit.response).toContain("Hash guard mismatch");

    const okEdit = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `/file edit ${targetFile} --find="line two" --replace="line 2" --hash=${originalHash}`,
      requestJob: false
    });
    expect(okEdit.response).toContain("Edited");
    const next = await fs.readFile(targetFile, "utf8");
    expect(next).toContain("line 2");
    expect(next).not.toContain("line two");
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
    expect(calls[0]?.[2]).toEqual({ authPreference: "api_key" });
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
    expect(String(calls[0]?.[1] ?? "")).toContain("new question");
    expect(String(calls[0]?.[1] ?? "")).not.toContain("old assistant line");
    expect(calls[0]?.[2]).toEqual({ authPreference: "auto" });
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
    expect(calls[0]?.[2]).toEqual({ authPreference: "api_key" });
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
