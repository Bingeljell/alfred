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

  it("supports approval-gated web search command", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-gw-web-search-unit-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

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
      undefined,
      undefined,
      undefined,
      {
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: true
      }
    );

    const gated = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/web latest OpenAI OAuth docs",
      requestJob: false
    });
    expect(gated.response).toContain("Approval required for web search");

    const token = String(gated.response?.split("approve ")[1] ?? "").trim();
    const approved = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: `approve ${token}`,
      requestJob: false
    });
    expect(approved.response).toContain("Approved action executed: web_search (queued job");
    const jobs = await queueStore.listJobs();
    expect(jobs.length).toBe(1);
    const queued = jobs[0];
    expect(queued?.status).toBe("queued");
    expect(queued?.payload?.taskType).toBe("web_search");
    expect(queued?.payload?.query).toBe("latest OpenAI OAuth docs");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(0);
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
    expect(notifications.enqueue).toHaveBeenCalled();
    const payloads = (notifications.enqueue as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (entry) => entry[0] as { status?: string; text?: string }
    );
    expect(payloads.some((entry) => entry.status === "queued")).toBe(true);
    expect(payloads.some((entry) => entry.status === "running")).toBe(true);
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
    expect(job?.payload?.taskType).toBe("web_search");

    const status = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "status?",
      requestJob: false
    });
    expect(status.response).toContain(`Latest job ${job?.id} is queued`);
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
    expect(chat.response).toContain("memory/2026-02-23.md:10:14");

    const calls = (llm.generateText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[1] ?? "")).toContain("Memory snippets:");
    expect(String(calls[0]?.[1] ?? "")).toContain("memory/2026-02-23.md:10:14");
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
});
