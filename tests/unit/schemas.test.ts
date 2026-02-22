import { describe, expect, it } from "vitest";
import { JobCreateSchema, ReceiptSchema } from "../../packages/contracts/src";

describe("contracts", () => {
  it("parses valid job create input", () => {
    const parsed = JobCreateSchema.parse({
      type: "stub_task",
      payload: { action: "ping" }
    });

    expect(parsed.priority).toBe(5);
    expect(parsed.type).toBe("stub_task");
  });

  it("rejects unknown job types", () => {
    expect(() =>
      JobCreateSchema.parse({
        type: "unknown",
        payload: {}
      })
    ).toThrow();
  });

  it("parses receipt format", () => {
    const parsed = ReceiptSchema.parse({
      receiptId: "r-1",
      jobId: "j-1",
      status: "success",
      actions: [{ at: new Date().toISOString(), step: "job.succeeded" }],
      timing: {
        queuedAt: new Date().toISOString(),
        durationMs: 0
      }
    });

    expect(parsed.jobId).toBe("j-1");
  });
});
