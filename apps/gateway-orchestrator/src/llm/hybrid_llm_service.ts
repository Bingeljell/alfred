import { CodexChatService } from "./codex_chat_service";
import { OpenAIResponsesService, type ResponsesResult } from "./openai_responses_service";

export class HybridLlmService {
  private readonly codex?: CodexChatService;
  private readonly responses?: OpenAIResponsesService;

  constructor(options: { codex?: CodexChatService; responses?: OpenAIResponsesService }) {
    this.codex = options.codex;
    this.responses = options.responses;
  }

  async generateText(sessionId: string, input: string): Promise<ResponsesResult | null> {
    if (this.codex) {
      try {
        const codex = await this.codex.generateText(sessionId, input);
        if (codex?.text) {
          return {
            text: codex.text,
            model: codex.model,
            authMode: codex.authMode
          };
        }
      } catch {
        // Fall through to Responses fallback.
      }
    }

    if (!this.responses) {
      return null;
    }

    return this.responses.generateText(sessionId, input);
  }
}
