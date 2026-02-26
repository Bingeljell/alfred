import { describe, expect, it, vi } from "vitest";
import { runNormalizePhase } from "../../apps/gateway-orchestrator/src/orchestrator/normalize_phase";
import { runSessionPhase } from "../../apps/gateway-orchestrator/src/orchestrator/session_phase";

describe("orchestrator phases", () => {
  it("normalizes inbound provider metadata into source/channel", () => {
    const normalized = runNormalizePhase({
      sessionId: "user@s.whatsapp.net",
      text: "hello",
      metadata: { provider: "baileys" }
    });

    expect(normalized.source).toBe("whatsapp");
    expect(normalized.channel).toBe("baileys");
    expect(normalized.provider).toBe("baileys");
  });

  it("creates session context with run ledger markers", async () => {
    const transitionPhase = vi.fn(async () => undefined);
    const appendEvent = vi.fn(async () => undefined);
    const completeRun = vi.fn(async () => undefined);
    const startRun = vi.fn(async () => ({
      acquired: true,
      run: { runId: "run-1" }
    }));

    const session = await runSessionPhase({
      normalized: runNormalizePhase({
        sessionId: "owner@s.whatsapp.net",
        text: "hi",
        metadata: { provider: "baileys", authPreference: "oauth" }
      }),
      resolveAuthSessionId: async () => "auth-session-1",
      normalizeAuthPreference: () => "oauth",
      normalizeQueueMode: () => "steer",
      resolveIdempotencyKey: () => "idem-1",
      runLedger: {
        startRun,
        transitionPhase,
        appendEvent,
        completeRun
      },
      codexApiKey: "",
      capabilityPolicySnapshot: {
        approvalMode: "balanced",
        approvalDefault: true,
        webSearchEnabled: true,
        webSearchRequireApproval: true,
        webSearchProvider: "searxng",
        fileWriteEnabled: true,
        fileWriteRequireApproval: true,
        fileWriteNotesOnly: true,
        fileWriteNotesDir: "notes"
      },
      buildSkillsSnapshot: () => ({ hash: "skills-v1", content: ["planner", "web"] })
    });

    await session.markPhase("normalize", "ok");
    await session.markRunNote("queued");
    await session.completeRun(null);

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "auth-session-1",
        queueMode: "steer",
        idempotencyKey: "idem-1",
        model: "openai-codex/default",
        provider: "openai-codex"
      })
    );
    expect(transitionPhase).toHaveBeenCalledWith("run-1", "normalize", "ok", undefined);
    expect(appendEvent).toHaveBeenCalledWith("run-1", "note", undefined, "queued", undefined);
    expect(completeRun).toHaveBeenCalledWith("run-1", "completed", undefined);
  });
});

