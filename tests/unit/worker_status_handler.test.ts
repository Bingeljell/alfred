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
      summary: "Planning the best approach..."
    });
    await onStatus({
      jobId: "j1",
      sessionId: "owner@s.whatsapp.net",
      status: "progress",
      summary: "Collecting context via searxng (attempt 1/2)..."
    });
    await onStatus({
      jobId: "j1",
      sessionId: "owner@s.whatsapp.net",
      status: "failed",
      summary: "processor_failure"
    });

    const notifyCalls = enqueue.mock.calls as unknown as Array<Array<Record<string, unknown> | undefined>>;
    const texts = notifyCalls.map((call) => String(call[0]?.text ?? ""));
    expect(texts.some((item) => item.includes("On it. I started this on the worker queue on worker-main-1."))).toBe(true);
    expect(texts.some((item) => item.includes("Planning the approach..."))).toBe(true);
    expect(texts.some((item) => item.includes("Gathering sources..."))).toBe(true);
    expect(texts.some((item) => item.includes("I hit an error while running this task"))).toBe(true);
  });
});
