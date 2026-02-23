import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";
import { IdentityProfileStore } from "../../apps/gateway-orchestrator/src/auth/identity_profile_store";
import { ConversationStore } from "../../apps/gateway-orchestrator/src/builtins/conversation_store";

describe("GatewayService llm path", () => {
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
});
