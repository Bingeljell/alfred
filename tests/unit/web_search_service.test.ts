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

  it("uses searxng provider and formats top results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "SearXNG Result",
            url: "https://example.com/one",
            content: "First snippet",
            engines: ["duckduckgo", "google"]
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "searxng",
      searxng: {
        url: "http://127.0.0.1:8080/search",
        language: "en",
        safeSearch: 1
      }
    });

    const result = await service.search("openai updates", {
      provider: "searxng",
      authSessionId: "owner@s.whatsapp.net"
    });

    expect(result?.provider).toBe("searxng");
    expect(result?.text).toContain("SearXNG web results");
    expect(result?.text).toContain("SearXNG Result - https://example.com/one");
    const [requestUrl] = fetchMock.mock.calls[0] as [URL];
    expect(String(requestUrl)).toContain("q=openai+updates");
    expect(String(requestUrl)).toContain("format=json");
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

  it("uses brightdata provider and formats top results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => "application/json"
      },
      json: async () => ({
        results: [
          {
            title: "Bright result",
            url: "https://example.com/bright",
            snippet: "Bright snippet"
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "brightdata",
      brightdata: {
        apiKey: "bright-key",
        zone: "serp_zone",
        serpUrl: "https://api.brightdata.com/request"
      }
    });

    const result = await service.search("best local llm", {
      provider: "brightdata",
      authSessionId: "owner@s.whatsapp.net"
    });

    expect(result?.provider).toBe("brightdata");
    expect(result?.text).toContain("BrightData web results");
    expect(result?.text).toContain("Bright result - https://example.com/bright");
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(init.headers.authorization).toBe("Bearer bright-key");
    expect(init.body).toContain("\"zone\":\"serp_zone\"");
  });

  it("falls back to brave when earlier auto providers are unavailable", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prioritizes openai for auto provider routing even when default is searxng", async () => {
    const llm = {
      generateText: vi.fn().mockResolvedValue({
        text: "OpenAI-first auto result"
      })
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "searxng",
      llmService: llm
    });

    const result = await service.search("agent orchestration", {
      provider: "auto",
      authSessionId: "owner@s.whatsapp.net",
      authPreference: "auto"
    });

    expect(result?.provider).toBe("openai");
    expect(result?.text).toContain("OpenAI-first auto result");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("falls through from timed-out openai auto search to searxng", async () => {
    const llm = {
      generateText: vi.fn().mockImplementation(
        () =>
          new Promise<null>(() => {
            // Simulate a hanging OpenAI/Codex web-research turn.
          })
      )
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "SearX fallback result",
            url: "https://example.com/fallback",
            content: "Fallback snippet from searxng",
            engines: ["duckduckgo"]
          }
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new WebSearchService({
      defaultProvider: "auto",
      llmService: llm,
      openai: {
        timeoutMs: 5
      },
      searxng: {
        url: "http://127.0.0.1:8080/search"
      }
    });

    const result = await service.search("agent orchestration fallback", {
      provider: "auto",
      authSessionId: "owner@s.whatsapp.net",
      authPreference: "auto"
    });

    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.provider).toBe("searxng");
    expect(result?.text).toContain("SearX fallback result");
  });
});
