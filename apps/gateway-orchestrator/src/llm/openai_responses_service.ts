import { OAuthService } from "../auth/oauth_service";

export type ResponsesAuthMode = "oauth" | "api_key";

export type ResponsesResult = {
  text: string;
  model: string;
  authMode: ResponsesAuthMode;
  responseId?: string;
};

export class OpenAIResponsesService {
  private readonly enabled: boolean;
  private readonly apiUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly oauthService?: OAuthService;

  constructor(options: {
    enabled?: boolean;
    apiUrl?: string;
    model?: string;
    timeoutMs?: number;
    apiKey?: string;
    oauthService?: OAuthService;
  }) {
    this.enabled = options.enabled ?? true;
    this.apiUrl = options.apiUrl ?? "https://api.openai.com/v1/responses";
    this.model = options.model ?? "gpt-4.1-mini";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.apiKey = options.apiKey?.trim() ? options.apiKey : undefined;
    this.oauthService = options.oauthService;
  }

  async generateText(sessionId: string, input: string): Promise<ResponsesResult | null> {
    if (!this.enabled || !input.trim()) {
      return null;
    }

    const credential = await this.resolveCredential(sessionId);
    if (!credential) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.bearerToken}`
        },
        body: JSON.stringify({
          model: this.model,
          input
        }),
        signal: controller.signal
      });

      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof payload.error === "object" &&
          payload.error &&
          "message" in payload.error &&
          typeof payload.error.message === "string"
            ? payload.error.message
            : `status_${response.status}`;
        throw new Error(`openai_response_error:${message}`);
      }

      const text = extractResponseText(payload);
      if (!text) {
        throw new Error("openai_response_empty_output");
      }

      const responseId = typeof payload.id === "string" ? payload.id : undefined;
      return {
        text,
        model: this.model,
        authMode: credential.mode,
        responseId
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveCredential(sessionId: string): Promise<{ mode: ResponsesAuthMode; bearerToken: string } | null> {
    if (this.oauthService) {
      const accessToken = await this.oauthService.getOpenAiAccessToken(sessionId);
      if (accessToken) {
        return {
          mode: "oauth",
          bearerToken: accessToken
        };
      }
    }

    if (this.apiKey) {
      return {
        mode: "api_key",
        bearerToken: this.apiKey
      };
    }

    return null;
  }
}

function extractResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = "content" in item ? item.content : undefined;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const entry of content) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        if ("text" in entry && typeof entry.text === "string" && entry.text.trim()) {
          parts.push(entry.text.trim());
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return "";
}
