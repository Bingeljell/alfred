import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchService } from "../../apps/gateway-orchestrator/src/builtins/web_search_service";

describe("WebSearchService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses openai provider through llm service", async () => {
    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "OpenAI web summary with citations"
      })
    };
    const service = new WebSearchService({
      defaultProvider: "openai",
      llmService: llm
    });

    const result = await service.search("latest ai headlines", {
      provider: "openai",
      authSessionId: "owner@s.whatsapp.net",
      authPreference: "auto"
    });

    expect(result?.provider).toBe("openai");
    expect(result?.text).toContain("OpenAI web summary");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("uses brave provider and formats top results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "OpenAI News",
              url: "https://openai.com/news",
              description: "Latest OpenAI updates."
            },
            {
              title: "Research Post",
              url: "https://example.com/research",
              description: "A useful research roundup."
            }
          ]
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "brave",
      brave: {
        apiKey: "brave-key"
      }
    });

    const result = await service.search("openai news", {
      provider: "brave",
      authSessionId: "owner@s.whatsapp.net"
    });

    expect(result?.provider).toBe("brave");
    expect(result?.text).toContain("Brave web results");
    expect(result?.text).toContain("OpenAI News - https://openai.com/news");

    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, { headers: Record<string, string> }];
    expect(String(requestUrl)).toContain("api.search.brave.com");
    expect(String(requestUrl)).toContain("q=openai+news");
    expect(init.headers["x-subscription-token"]).toBe("brave-key");
  });

  it("uses perplexity provider and appends citations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Perplexity answer with concise summary."
            }
          }
        ],
        citations: ["https://perplexity.ai/source/1", "https://example.com/source/2"]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "perplexity",
      perplexity: {
        apiKey: "px-key"
      }
    });

    const result = await service.search("what changed this week", {
      provider: "perplexity",
      authSessionId: "owner@s.whatsapp.net"
    });

    expect(result?.provider).toBe("perplexity");
    expect(result?.text).toContain("Perplexity answer with concise summary.");
    expect(result?.text).toContain("Sources:");
    expect(result?.text).toContain("https://perplexity.ai/source/1");
  });

  it("falls back from openai to brave when openai is unavailable in auto mode", async () => {
    const llm = {
      generateText: vi.fn().mockResolvedValue(null)
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "Fallback result",
              url: "https://example.com/fallback",
              description: "Fallback snippet"
            }
          ]
        }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "openai",
      llmService: llm,
      brave: {
        apiKey: "brave-key"
      }
    });

    const result = await service.search("fallback query", {
      provider: "auto",
      authSessionId: "owner@s.whatsapp.net"
    });

    expect(result?.provider).toBe("brave");
    expect(result?.text).toContain("Fallback result");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
