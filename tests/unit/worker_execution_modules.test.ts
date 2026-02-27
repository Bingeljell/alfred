import { describe, expect, it, vi } from "vitest";
import { createWorkerProcessor } from "../../apps/worker/src/execution/processor";

describe("worker execution modules", () => {
  it("executes agentic_turn with synthesis over collected web context", async () => {
    const search = vi.fn(async () => ({
      provider: "searxng" as const,
      text:
        "1. Option A - https://example.com/a | solid quality\n" +
        "2. Option B - https://example.net/b | fast iteration\n" +
        "3. Option C - https://example.org/c | lower cost"
    }));
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          confidence: "high",
          topPick: "Option A",
          summary: "Option A offers the best quality/performance balance.",
          ambiguityReasons: [],
          followUpQuestions: [],
          candidates: [
            {
              name: "Option A",
              category: "model",
              score: 91,
              pros: ["high quality"],
              cons: ["higher cost"],
              rationale: "Best overall quality with consistent results.",
              evidenceUrls: ["https://example.com/a"]
            },
            {
              name: "Option B",
              category: "model",
              score: 83,
              pros: ["fast"],
              cons: ["quality variance"],
              rationale: "Good alternative when speed is top priority.",
              evidenceUrls: ["https://example.net/b"]
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        text: "Recommendation: Option A\n\nWhy this pick: Best overall quality.\n\nSources:\n- https://example.com/a"
      });
    const setPages = vi.fn(async () => undefined);
    const clearPages = vi.fn(async () => undefined);
    const reportProgress = vi.fn(async () => undefined);

    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "searxng"
      },
      webSearchService: {
        search
      },
      llmService: {
        generateText
      },
      pagedResponseStore: {
        setPages,
        clear: clearPages
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-agentic-1",
        type: "stub_task",
        payload: {
          taskType: "agentic_turn",
          query: "best ai orchestrators in 2026",
          sessionId: "owner@s.whatsapp.net",
          authSessionId: "owner@s.whatsapp.net"
        },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress
      }
    );

    expect(result.summary).toBe("agentic_turn_searxng");
    expect(result.mode).toBe("agentic_turn");
    expect(String(result.responseText)).toContain("Recommendation: Option A");
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(generateText.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(clearPages).toHaveBeenCalledTimes(1);
    expect(setPages).not.toHaveBeenCalled();

    const progressCalls = reportProgress.mock.calls as unknown as Array<Array<Record<string, unknown> | undefined>>;
    const progressMessages = progressCalls.map((call) => String(call[0]?.message ?? ""));
    expect(progressMessages.some((item) => String(item).includes("Task accepted. Search focus prepared:"))).toBe(true);
    expect(progressMessages.some((item) => String(item).includes("Retrieving sources via"))).toBe(true);
    expect(progressMessages).toContain("Composing final recommendation from ranked evidence.");
  });

  it("falls back to rank-only recommendation when synthesis fails", async () => {
    const search = vi.fn(async () => ({
      provider: "brave" as const,
      text:
        "1. Candidate One - https://example.com/one | strong ecosystem\n" +
        "2. Candidate Two - https://example.net/two | lower cost\n" +
        "3. Candidate Three - https://example.org/three | open source"
    }));
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          confidence: "medium",
          topPick: "Candidate One",
          summary: "Best ecosystem fit.",
          ambiguityReasons: [],
          followUpQuestions: [],
          candidates: [
            {
              name: "Candidate One",
              category: "tool",
              score: 88,
              pros: ["ecosystem"],
              cons: ["cost"],
              rationale: "Strongest integration ecosystem.",
              evidenceUrls: ["https://example.com/one"]
            },
            {
              name: "Candidate Two",
              category: "tool",
              score: 80,
              pros: ["cost"],
              cons: ["fewer integrations"],
              rationale: "Lower cost option with decent capability.",
              evidenceUrls: ["https://example.net/two"]
            }
          ]
        })
      })
      .mockRejectedValueOnce(new Error("llm_unavailable"));
    const setPages = vi.fn(async () => undefined);
    const clearPages = vi.fn(async () => undefined);

    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "searxng"
      },
      webSearchService: {
        search
      },
      llmService: {
        generateText
      },
      pagedResponseStore: {
        setPages,
        clear: clearPages
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-agentic-2",
        type: "stub_task",
        payload: {
          taskType: "agentic_turn",
          query: "compare orchestration tools",
          sessionId: "owner@s.whatsapp.net",
          authSessionId: "owner@s.whatsapp.net"
        },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress: async () => undefined
      }
    );

    expect(result.summary).toBe("agentic_turn_brave");
    expect(String(result.responseText)).toContain("Recommendation: Candidate One");
    expect(String(result.responseText)).toContain("Confidence: medium");
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(generateText.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(clearPages).toHaveBeenCalledTimes(1);
    expect(setPages).not.toHaveBeenCalled();
  });

  it("returns deterministic fallback summary for non-web tasks", async () => {
    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "searxng"
      },
      webSearchService: {
        search: async () => null
      },
      llmService: {
        generateText: async () => ({ text: "ok" })
      },
      pagedResponseStore: {
        setPages: async () => undefined,
        clear: async () => undefined
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-1",
        type: "stub_task",
        payload: { action: "ping" },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress: async () => undefined
      }
    );

    expect(result.summary).toBe("processed:ping");
  });

  it("runs fallback provider when searxng coverage is weak in auto mode", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "searxng" as const,
        text: "1. Blog A - https://example.com/a | summary"
      })
      .mockResolvedValueOnce({
        provider: "openai" as const,
        text:
          "1. Vendor docs - https://docs.vendor.com/guide | details\n" +
          "2. Comparison - https://independent.net/review | notes\n" +
          "3. Benchmarks - https://benchmarks.org/report | metrics"
      });
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          confidence: "medium",
          topPick: "Vendor docs stack",
          summary: "Best documented and practical choice.",
          ambiguityReasons: [],
          followUpQuestions: [],
          candidates: [
            {
              name: "Vendor docs stack",
              category: "tool",
              score: 86,
              pros: ["documentation"],
              cons: ["vendor lock-in"],
              rationale: "Best practical reliability from evidence set.",
              evidenceUrls: ["https://docs.vendor.com/guide"]
            },
            {
              name: "Independent alternative",
              category: "tool",
              score: 79,
              pros: ["flexibility"],
              cons: ["steeper setup"],
              rationale: "More flexible but harder onboarding.",
              evidenceUrls: ["https://independent.net/review"]
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        text: "Recommendation: Vendor docs stack"
      });

    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "auto"
      },
      webSearchService: {
        search
      },
      llmService: {
        generateText
      },
      pagedResponseStore: {
        setPages: async () => undefined,
        clear: async () => undefined
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-agentic-fallback",
        type: "stub_task",
        payload: {
          taskType: "agentic_turn",
          query: "best terminal for coding agents",
          provider: "auto",
          sessionId: "owner@s.whatsapp.net",
          authSessionId: "owner@s.whatsapp.net"
        },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress: async () => undefined
      }
    );

    expect(result.summary).toBe("agentic_turn_searxng");
    expect(String(result.responseText)).toContain("Recommendation: Vendor docs stack");
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[0]?.[1]?.provider).toBe("searxng");
    expect(search.mock.calls[1]?.[1]?.provider).toBe("openai");
  });

  it("asks clarification when ranking reports ambiguity", async () => {
    const search = vi.fn(async () => ({
      provider: "searxng" as const,
      text:
        "1. Tool A - https://a.example.com | good quality\n" +
        "2. Tool B - https://b.example.com | better speed\n" +
        "3. Tool C - https://c.example.com | lower cost"
    }));
    const generateText = vi.fn(async () => ({
      text: JSON.stringify({
        confidence: "low",
        topPick: "",
        summary: "",
        ambiguityReasons: ["missing_priority"],
        followUpQuestions: ["What matters most: cost, quality, speed, or ecosystem?"],
        candidates: [
          {
            name: "Tool A",
            category: "tool",
            score: 71,
            pros: ["quality"],
            cons: ["cost"],
            rationale: "Need user priority to finalize.",
            evidenceUrls: ["https://a.example.com"]
          }
        ]
      })
    }));

    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "searxng"
      },
      webSearchService: {
        search
      },
      llmService: {
        generateText
      },
      pagedResponseStore: {
        setPages: async () => undefined,
        clear: async () => undefined
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-agentic-clarify",
        type: "stub_task",
        payload: {
          taskType: "agentic_turn",
          query: "recommend the best coding terminal",
          sessionId: "owner@s.whatsapp.net",
          authSessionId: "owner@s.whatsapp.net"
        },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress: async () => undefined
      }
    );

    expect(result.summary).toBe("agentic_turn_needs_clarification");
    expect(String(result.responseText)).toContain("Before I recommend one option");
    expect(String(result.responseText)).toContain("What matters most");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("returns missing-query response for web_search with empty query", async () => {
    const search = vi.fn(async () => null);
    const processor = createWorkerProcessor({
      config: {
        alfredWorkspaceDir: "/tmp/alfred",
        alfredWebSearchProvider: "searxng"
      },
      webSearchService: {
        search
      },
      llmService: {
        generateText: async () => ({ text: "ok" })
      },
      pagedResponseStore: {
        setPages: async () => undefined,
        clear: async () => undefined
      },
      notificationStore: {
        enqueue: async () => undefined
      },
      runSpecStore: {
        put: async () => undefined,
        setStatus: async () => null,
        updateStep: async () => null
      }
    });

    const result = await processor(
      {
        id: "j-2",
        type: "stub_task",
        payload: { taskType: "web_search", query: "   ", sessionId: "owner@s.whatsapp.net" },
        priority: 5,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        reportProgress: async () => undefined
      }
    );

    expect(result.summary).toBe("web_search_missing_query");
    expect(search).not.toHaveBeenCalled();
  });
});
