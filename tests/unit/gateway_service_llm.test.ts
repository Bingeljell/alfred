import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";

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
});
