import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";
import { IdentityProfileStore } from "../../apps/gateway-orchestrator/src/auth/identity_profile_store";

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

    expect(chat.response).toBe("ack:fallback please");
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
});
