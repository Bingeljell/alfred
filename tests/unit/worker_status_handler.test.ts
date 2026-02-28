import { describe, expect, it, vi } from "vitest";
import { createWorkerStatusHandler } from "../../apps/worker/src/execution/status_handler";

describe("worker status handler", () => {
  it("emits user-friendly running/progress/failure notifications and includes worker hint", async () => {
    const enqueue = vi.fn(async () => ({ id: "n1" }));
    const getJob = vi.fn(async () => null);
    const updateChildByJob = vi.fn(async () => null);
    const summarize = vi.fn(() => "summary");

    const onStatus = createWorkerStatusHandler({
      notificationStore: {
        enqueue
      },
      store: {
        getJob
      },
      supervisorStore: {
        updateChildByJob,
        summarize
      }
    });

    await onStatus({
      jobId: "j1",
      workerId: "worker-main-1",
      sessionId: "owner@s.whatsapp.net",
      status: "running"
    });
    await onStatus({
      jobId: "j1",
      sessionId: "owner@s.whatsapp.net",
      status: "progress",
      phase: "plan",
      summary: "Task accepted. Planning recommendation workflow."
    });
    await onStatus({
      jobId: "j1",
      sessionId: "owner@s.whatsapp.net",
      status: "progress",
      phase: "retrieve",
      summary: "Retrieved 8 sources across 5 domains via searxng.",
      details: {
        provider: "searxng",
        hitCount: 8,
        domainCount: 5
      }
    });
    await onStatus({
      jobId: "j1",
      sessionId: "owner@s.whatsapp.net",
      status: "failed",
      summary: "processor_failure"
    });

    const notifyCalls = enqueue.mock.calls as unknown as Array<Array<Record<string, unknown> | undefined>>;
    const texts = notifyCalls.map((call) => String(call[0]?.text ?? ""));
    expect(texts.some((item) => item.includes("On it. This task is running on the worker queue on worker-main-1."))).toBe(true);
    expect(texts.some((item) => item.includes("Task accepted. Planning recommendation workflow."))).toBe(true);
    expect(texts.some((item) => item.includes("Retrieved 8 sources across 5 domains via searxng."))).toBe(true);
    expect(texts.some((item) => item.includes("I hit an error while running this task"))).toBe(true);
  });
});
