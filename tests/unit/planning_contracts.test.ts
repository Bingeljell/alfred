import { describe, expect, it } from "vitest";
import { PlanDecisionSchema, PlanProposalSchema, RunSpecLockSchema } from "../../packages/contracts/src";

describe("planning contracts", () => {
  it("parses worker plan proposal with suggested runspec", () => {
    const parsed = PlanProposalSchema.parse({
      version: 1,
      proposalId: "proposal-1",
      sessionKey: "wa-user-1",
      source: "worker",
      requestedAt: new Date().toISOString(),
      rationale: "Need worker-side decomposition for long task",
      suggestedRunSpec: {
        version: 1,
        id: "runspec-1",
        goal: "Research and send summary",
        steps: [
          { id: "search", type: "web.search", name: "Search", input: { query: "latest agent orchestration" } },
          { id: "compose", type: "doc.compose", name: "Compose", input: {} }
        ]
      }
    });

    expect(parsed.source).toBe("worker");
    expect(parsed.suggestedRunSpec.steps).toHaveLength(2);
  });

  it("parses gateway decision with approved runspec", () => {
    const parsed = PlanDecisionSchema.parse({
      version: 1,
      proposalId: "proposal-1",
      sessionKey: "wa-user-1",
      decision: "approved",
      decidedAt: new Date().toISOString(),
      reason: "Within policy and budget",
      approvedRunSpec: {
        version: 1,
        id: "runspec-1",
        goal: "Research and send summary",
        steps: [{ id: "search", type: "web.search", name: "Search", input: { query: "latest" } }]
      }
    });

    expect(parsed.decision).toBe("approved");
    expect(parsed.approvedRunSpec?.id).toBe("runspec-1");
  });

  it("parses immutable runspec lock metadata", () => {
    const parsed = RunSpecLockSchema.parse({
      version: 1,
      runId: "run-1",
      sessionKey: "wa-user-1",
      runSpecId: "runspec-1",
      runSpecRevision: 2,
      runSpecHash: "sha256:abc123",
      approvedAt: new Date().toISOString(),
      approvedBy: "gateway",
      sourceProposalId: "proposal-1"
    });

    expect(parsed.runSpecRevision).toBe(2);
    expect(parsed.approvedBy).toBe("gateway");
  });
});
