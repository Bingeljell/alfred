import { describe, expect, it, vi } from "vitest";
import { OAuthService } from "../../apps/gateway-orchestrator/src/auth/oauth_service";
import { OpenAIResponsesService } from "../../apps/gateway-orchestrator/src/llm/openai_responses_service";

describe("OpenAIResponsesService", () => {
  it("uses oauth token before api key when both are available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resp_1", output_text: "hello from oauth" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const oauth = {
      getOpenAiAccessToken: vi.fn().mockResolvedValue("oauth-token-123")
    } as unknown as OAuthService;

    const service = new OpenAIResponsesService({
      oauthService: oauth,
      apiKey: "api-key-abc",
      model: "gpt-4.1-mini",
      apiUrl: "https://api.openai.com/v1/responses"
    });

    const result = await service.generateText("owner@s.whatsapp.net", "Say hi");

    expect(result?.text).toBe("hello from oauth");
    expect(result?.authMode).toBe("oauth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers.authorization).toBe("Bearer oauth-token-123");

    vi.unstubAllGlobals();
  });

  it("falls back to api key when oauth token is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "resp_2",
        output: [{ content: [{ type: "output_text", text: "hello from api key" }] }]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const oauth = {
      getOpenAiAccessToken: vi.fn().mockResolvedValue(null)
    } as unknown as OAuthService;

    const service = new OpenAIResponsesService({
      oauthService: oauth,
      apiKey: "api-key-xyz"
    });

    const result = await service.generateText("owner@s.whatsapp.net", "Say hi");
    expect(result?.text).toBe("hello from api key");
    expect(result?.authMode).toBe("api_key");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe("Bearer api-key-xyz");

    vi.unstubAllGlobals();
  });

  it("returns null when no credential is configured", async () => {
    const service = new OpenAIResponsesService({
      enabled: true
    });

    const result = await service.generateText("owner@s.whatsapp.net", "hello");
    expect(result).toBeNull();
  });
});
