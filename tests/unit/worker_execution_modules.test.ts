import { describe, expect, it, vi } from "vitest";
import { createWorkerProcessor } from "../../apps/worker/src/execution/processor";

describe("worker execution modules", () => {
  it("executes agentic_turn with synthesis over collected web context", async () => {
    const search = vi.fn(async () => ({
      provider: "searxng" as const,
      text: "1. Option A - https://example.com/a\n2. Option B - https://example.com/b"
    }));
    const generateText = vi.fn(async () => ({
      text: "- Best fit: Option A\n- Alternative: Option B"
    }));
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
    expect(String(result.responseText)).toContain("Best fit: Option A");
    expect(search).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(clearPages).toHaveBeenCalledTimes(1);
    expect(setPages).not.toHaveBeenCalled();

    const progressCalls = reportProgress.mock.calls as unknown as Array<Array<Record<string, unknown> | undefined>>;
    const progressMessages = progressCalls.map((call) => String(call[0]?.message ?? ""));
    expect(progressMessages).toContain("Planning the best approach...");
    expect(progressMessages.some((item) => String(item).includes("Collecting context via"))).toBe(true);
    expect(progressMessages).toContain("Comparing findings and drafting recommendation...");
  });

  it("falls back to raw-context response when agentic synthesis fails", async () => {
    const search = vi.fn(async () => ({
      provider: "brave" as const,
      text: "1. Candidate One - https://example.com/one"
    }));
    const generateText = vi.fn(async () => {
      throw new Error("llm_unavailable");
    });
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
    expect(String(result.responseText)).toContain("I couldn't finish deep synthesis in time, but I found strong sources via brave.");
    expect(String(result.responseText)).toContain("Candidate One");
    expect(String(result.responseText)).toContain("Provisional recommendation");
    expect(search).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
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
