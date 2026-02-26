import { describe, expect, it, vi } from "vitest";
import { createWorkerProcessor } from "../../apps/worker/src/execution/processor";

describe("worker execution modules", () => {
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
