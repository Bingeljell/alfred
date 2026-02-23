import { describe, expect, it } from "vitest";
import { CodexChatService } from "../../apps/gateway-orchestrator/src/llm/codex_chat_service";
import { HybridLlmService } from "../../apps/gateway-orchestrator/src/llm/hybrid_llm_service";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";

describe("HybridLlmService", () => {
  it("prefers codex output when available", async () => {
    const codex = {
      generateText: async () => ({
        text: "from codex",
        model: "openai-codex/x",
        authMode: "oauth" as const
      })
    } as unknown as CodexChatService;

    const responses = {
      generateText: async () => ({
        text: "from api",
        model: "gpt-4.1-mini",
        authMode: "api_key" as const
      })
    } as unknown as OpenAIResponsesService;

    const hybrid = new HybridLlmService({
      codex,
      responses
    });

    const result = await hybrid.generateText("owner@s.whatsapp.net", "hello");
    expect(result?.text).toBe("from codex");
  });

  it("falls back to responses when codex throws", async () => {
    const codex = {
      generateText: async () => {
        throw new Error("codex failed");
      }
    } as unknown as CodexChatService;

    const responses = {
      generateText: async () => ({
        text: "from fallback",
        model: "gpt-4.1-mini",
        authMode: "api_key" as const
      })
    } as unknown as OpenAIResponsesService;

    const hybrid = new HybridLlmService({
      codex,
      responses
    });

    const result = await hybrid.generateText("owner@s.whatsapp.net", "hello");
    expect(result?.text).toBe("from fallback");
  });

  it("throws codex error when fallback has no credential/result", async () => {
    const codex = {
      generateText: async () => {
        throw new Error("codex failed hard");
      }
    } as unknown as CodexChatService;

    const responses = {
      generateText: async () => null
    } as unknown as OpenAIResponsesService;

    const hybrid = new HybridLlmService({
      codex,
      responses
    });

    await expect(hybrid.generateText("owner@s.whatsapp.net", "hello")).rejects.toThrow("codex failed hard");
  });
});
