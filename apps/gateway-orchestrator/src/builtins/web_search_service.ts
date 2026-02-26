export type WebSearchProvider = "searxng" | "openai" | "brave" | "perplexity" | "brightdata" | "auto";
type LlmAuthPreference = "auto" | "oauth" | "api_key";

type WebSearchResult = {
  provider: "searxng" | "openai" | "brave" | "perplexity" | "brightdata";
  text: string;
};

export class WebSearchService {
  private readonly defaultProvider: WebSearchProvider;
  private readonly llmService?: {
    generateText: (
      sessionId: string,
      input: string,
      options?: { authPreference?: LlmAuthPreference }
    ) => Promise<{ text: string } | null>;
  };
  private readonly braveApiKey?: string;
  private readonly braveUrl: string;
  private readonly braveTimeoutMs: number;
  private readonly braveMaxResults: number;
  private readonly searxngUrl: string;
  private readonly searxngTimeoutMs: number;
  private readonly searxngMaxResults: number;
  private readonly searxngLanguage: string;
  private readonly searxngSafeSearch: number;
  private readonly brightDataApiKey?: string;
  private readonly brightDataSerpUrl: string;
  private readonly brightDataZone?: string;
  private readonly brightDataTimeoutMs: number;
  private readonly brightDataMaxResults: number;
  private readonly perplexityApiKey?: string;
  private readonly perplexityUrl: string;
  private readonly perplexityModel: string;
  private readonly perplexityTimeoutMs: number;

  constructor(options?: {
    defaultProvider?: WebSearchProvider;
    llmService?: {
      generateText: (
        sessionId: string,
        input: string,
        options?: { authPreference?: LlmAuthPreference }
      ) => Promise<{ text: string } | null>;
    };
    brave?: {
      apiKey?: string;
      url?: string;
      timeoutMs?: number;
      maxResults?: number;
    };
    searxng?: {
      url?: string;
      timeoutMs?: number;
      maxResults?: number;
      language?: string;
      safeSearch?: number;
    };
    brightdata?: {
      apiKey?: string;
      serpUrl?: string;
      zone?: string;
      timeoutMs?: number;
      maxResults?: number;
    };
    perplexity?: {
      apiKey?: string;
      url?: string;
      model?: string;
      timeoutMs?: number;
    };
  }) {
    this.defaultProvider = options?.defaultProvider ?? "openai";
    this.llmService = options?.llmService;
    this.braveApiKey = options?.brave?.apiKey?.trim() ? options.brave.apiKey : undefined;
    this.braveUrl = options?.brave?.url ?? "https://api.search.brave.com/res/v1/web/search";
    this.braveTimeoutMs = options?.brave?.timeoutMs ?? 12000;
    this.braveMaxResults = options?.brave?.maxResults ?? 5;
    this.searxngUrl = options?.searxng?.url ?? "http://127.0.0.1:8080/search";
    this.searxngTimeoutMs = options?.searxng?.timeoutMs ?? 12000;
    this.searxngMaxResults = options?.searxng?.maxResults ?? 5;
    this.searxngLanguage = options?.searxng?.language?.trim() || "en";
    this.searxngSafeSearch = Number.isFinite(options?.searxng?.safeSearch) ? Number(options?.searxng?.safeSearch) : 1;
    this.brightDataApiKey = options?.brightdata?.apiKey?.trim() ? options.brightdata.apiKey : undefined;
    this.brightDataSerpUrl = options?.brightdata?.serpUrl ?? "https://api.brightdata.com/request";
    this.brightDataZone = options?.brightdata?.zone?.trim() ? options.brightdata.zone.trim() : undefined;
    this.brightDataTimeoutMs = options?.brightdata?.timeoutMs ?? 15000;
    this.brightDataMaxResults = options?.brightdata?.maxResults ?? 5;
    this.perplexityApiKey = options?.perplexity?.apiKey?.trim() ? options.perplexity.apiKey : undefined;
    this.perplexityUrl = options?.perplexity?.url ?? "https://api.perplexity.ai/chat/completions";
    this.perplexityModel = options?.perplexity?.model ?? "sonar";
    this.perplexityTimeoutMs = options?.perplexity?.timeoutMs ?? 20000;
  }

  async search(
    query: string,
    options: {
      provider?: WebSearchProvider;
      authSessionId: string;
      authPreference?: LlmAuthPreference;
    }
  ): Promise<WebSearchResult | null> {
    const providerOrder = this.resolveProviderOrder(options.provider);
    let lastError: unknown;

    for (const provider of providerOrder) {
      try {
        if (provider === "searxng") {
          const text = await this.searchWithSearxng(query);
          if (text) {
            return { provider: "searxng", text };
          }
          continue;
        }
        if (provider === "openai") {
          const text = await this.searchWithOpenAi(query, options.authSessionId, options.authPreference ?? "auto");
          if (text) {
            return { provider: "openai", text };
          }
          continue;
        }
        if (provider === "brave") {
          const text = await this.searchWithBrave(query);
          if (text) {
            return { provider: "brave", text };
          }
          continue;
        }
        if (provider === "perplexity") {
          const text = await this.searchWithPerplexity(query);
          if (text) {
            return { provider: "perplexity", text };
          }
          continue;
        }
        if (provider === "brightdata") {
          const text = await this.searchWithBrightData(query);
          if (text) {
            return { provider: "brightdata", text };
          }
          continue;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  }

  private resolveProviderOrder(requested?: WebSearchProvider): Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata"> {
    const all: Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata"> = [
      "searxng",
      "openai",
      "brave",
      "perplexity",
      "brightdata"
    ];
    if (requested && requested !== "auto") {
      return [requested];
    }
    if (requested === "auto") {
      const ordered: Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata"> = ["openai"];
      for (const provider of all) {
        if (!ordered.includes(provider)) {
          ordered.push(provider);
        }
      }
      return ordered;
    }

    if (this.defaultProvider && this.defaultProvider !== "auto") {
      return [this.defaultProvider, ...all.filter((provider) => provider !== this.defaultProvider)];
    }
    return all;
  }

  private async searchWithSearxng(query: string): Promise<string | null> {
    const url = new URL(this.searxngUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.searxngLanguage);
    url.searchParams.set("safesearch", String(this.searxngSafeSearch));

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.searxngTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json"
        },
        signal: controller.signal
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`searxng_search_error:${response.status}`);
      }

      const results = extractSearxngResults(payload, this.searxngMaxResults);
      if (results.length === 0) {
        return null;
      }
      const lines = results.map((item, index) => {
        const snippet = item.snippet ? ` | ${item.snippet}` : "";
        const engines = item.engines.length > 0 ? ` [engines: ${item.engines.join(", ")}]` : "";
        return `${index + 1}. ${item.title} - ${item.url}${snippet}${engines}`;
      });
      return `SearXNG web results:\n${lines.join("\n")}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchWithOpenAi(query: string, authSessionId: string, authPreference: LlmAuthPreference): Promise<string | null> {
    if (!this.llmService) {
      return null;
    }

    const prompt = [
      "You are a web research assistant.",
      "Use available web-search/browsing tools if available.",
      "Return concise findings with source links and publication dates when possible.",
      `Query: ${query.trim()}`
    ].join("\n");
    const result = await this.llmService.generateText(authSessionId, prompt, { authPreference });
    const text = result?.text?.trim();
    return text ? text : null;
  }

  private async searchWithBrave(query: string): Promise<string | null> {
    if (!this.braveApiKey) {
      return null;
    }

    const url = new URL(this.braveUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.braveMaxResults));

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.braveTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": this.braveApiKey
        },
        signal: controller.signal
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`brave_search_error:${response.status}`);
      }

      const results = extractBraveResults(payload, this.braveMaxResults);
      if (results.length === 0) {
        return "No Brave results found for this query.";
      }

      const lines = results.map((item, index) => {
        const snippet = item.snippet ? ` | ${item.snippet}` : "";
        return `${index + 1}. ${item.title} - ${item.url}${snippet}`;
      });
      return `Brave web results:\n${lines.join("\n")}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchWithPerplexity(query: string): Promise<string | null> {
    if (!this.perplexityApiKey) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.perplexityTimeoutMs);

    try {
      const response = await fetch(this.perplexityUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.perplexityApiKey}`
        },
        body: JSON.stringify({
          model: this.perplexityModel,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "Provide concise web research with source links."
            },
            {
              role: "user",
              content: query.trim()
            }
          ]
        }),
        signal: controller.signal
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`perplexity_search_error:${response.status}`);
      }

      const answer = extractPerplexityAnswer(payload);
      if (!answer) {
        return null;
      }
      const citations = extractPerplexityCitations(payload);
      if (citations.length === 0) {
        return answer;
      }
      return `${answer}\n\nSources:\n${citations.map((item) => `- ${item}`).join("\n")}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async searchWithBrightData(query: string): Promise<string | null> {
    if (!this.brightDataApiKey || !this.brightDataZone) {
      return null;
    }

    const targetUrl = new URL("https://www.google.com/search");
    targetUrl.searchParams.set("q", query);
    targetUrl.searchParams.set("num", String(this.brightDataMaxResults));

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.brightDataTimeoutMs);

    try {
      const response = await fetch(this.brightDataSerpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.brightDataApiKey}`
        },
        body: JSON.stringify({
          zone: this.brightDataZone,
          url: targetUrl.toString(),
          format: "json"
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`brightdata_search_error:${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.toLowerCase().includes("application/json")) {
        const payload = (await response.json()) as Record<string, unknown>;
        const results = extractBrightDataResults(payload, this.brightDataMaxResults);
        if (results.length === 0) {
          return null;
        }
        const lines = results.map((item, index) => {
          const snippet = item.snippet ? ` | ${item.snippet}` : "";
          return `${index + 1}. ${item.title} - ${item.url}${snippet}`;
        });
        return `BrightData web results:\n${lines.join("\n")}`;
      }

      const text = await response.text();
      if (!text.trim()) {
        return null;
      }
      return `BrightData returned a non-JSON payload (${Math.min(text.length, 20000)} chars).`;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractSearxngResults(
  payload: Record<string, unknown>,
  maxResults: number
): Array<{ title: string; url: string; snippet: string; engines: string[] }> {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const items: Array<{ title: string; url: string; snippet: string; engines: string[] }> = [];
  for (const entry of rawResults) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const title = String(record.title ?? "").trim();
    const url = String(record.url ?? "").trim();
    if (!title || !url) {
      continue;
    }
    const snippet = String(record.content ?? record.snippet ?? "").replace(/\s+/g, " ").trim();
    const engines = Array.isArray(record.engines)
      ? record.engines
          .map((engine) => String(engine ?? "").trim())
          .filter((engine) => engine.length > 0)
          .slice(0, 3)
      : [];
    items.push({ title, url, snippet, engines });
    if (items.length >= maxResults) {
      break;
    }
  }
  return items;
}

function extractBraveResults(
  payload: Record<string, unknown>,
  maxResults: number
): Array<{ title: string; url: string; snippet?: string }> {
  const web = payload.web;
  if (!web || typeof web !== "object") {
    return [];
  }
  const results = "results" in web ? (web.results as unknown) : undefined;
  if (!Array.isArray(results)) {
    return [];
  }

  const collected: Array<{ title: string; url: string; snippet?: string }> = [];
  for (const item of results) {
    if (collected.length >= maxResults) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const snippet = typeof item.description === "string" ? item.description.trim() : "";
    if (!title || !url) {
      continue;
    }
    collected.push({
      title,
      url,
      snippet: snippet || undefined
    });
  }
  return collected;
}

function extractPerplexityAnswer(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return "";
  }
  const message = "message" in first ? first.message : undefined;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = "content" in message ? message.content : undefined;
  if (typeof content !== "string") {
    return "";
  }
  return content.trim();
}

function extractPerplexityCitations(payload: Record<string, unknown>): string[] {
  const citations = payload.citations;
  if (!Array.isArray(citations)) {
    return [];
  }
  return citations
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function extractBrightDataResults(
  payload: Record<string, unknown>,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const candidates: unknown[] = [];
  const directLists = [
    payload.results,
    payload.organic,
    payload.organic_results,
    payload.data,
    (payload.response as Record<string, unknown> | undefined)?.results
  ];
  for (const entry of directLists) {
    if (Array.isArray(entry)) {
      candidates.push(...entry);
      break;
    }
  }

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const title = String(record.title ?? record.name ?? "").trim();
    const url = String(record.url ?? record.link ?? "").trim();
    if (!title || !url) {
      continue;
    }
    const snippet = String(record.description ?? record.snippet ?? record.content ?? "")
      .replace(/\s+/g, " ")
      .trim();
    results.push({ title, url, snippet });
    if (results.length >= maxResults) {
      break;
    }
  }
  return results;
}
