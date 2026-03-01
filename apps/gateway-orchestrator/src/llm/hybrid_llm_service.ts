import { CodexChatService } from "./codex_chat_service";
import { OpenAIResponsesService, type LlmAuthPreference, type ResponsesResult } from "./openai_responses_service";
import type { LlmExecutionMode } from "../orchestrator/types";

export class HybridLlmService {
  private readonly codex?: CodexChatService;
  private readonly responses?: OpenAIResponsesService;

  constructor(options: { codex?: CodexChatService; responses?: OpenAIResponsesService }) {
    this.codex = options.codex;
    this.responses = options.responses;
  }

  async generateText(
    sessionId: string,
    input: string,
    options?: { authPreference?: LlmAuthPreference; executionMode?: LlmExecutionMode }
  ): Promise<ResponsesResult | null> {
    const authPreference = options?.authPreference ?? "auto";
    const executionMode = options?.executionMode ?? "default";
    let codexError: unknown;

    if (this.codex && authPreference !== "api_key") {
      try {
        const codex = await this.codex.generateText(sessionId, input, { executionMode });
        if (codex?.text) {
          return {
            text: codex.text,
            model: codex.model,
            authMode: codex.authMode
          };
        }
      } catch (error) {
        codexError = error;
      }
    }

    if (!this.responses) {
      if (codexError) {
        throw codexError;
      }
      return null;
    }

    const fallback = await this.responses.generateText(sessionId, input, { authPreference, executionMode });
    if (fallback) {
      return fallback;
    }
    if (codexError) {
      throw codexError;
    }

    return null;
  }
}
