import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SupervisorStore } from "../../apps/gateway-orchestrator/src/builtins/supervisor_store";

describe("SupervisorStore", () => {
  it("creates web fanout run and tracks child lifecycle", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-supervisor-store-unit-"));
    const store = new SupervisorStore(stateDir);
    await store.ensureReady();

    const run = await store.createWebFanout({
      sessionId: "owner@s.whatsapp.net",
      query: "compare top models",
      children: [
        { provider: "openai", maxRetries: 1, timeBudgetMs: 120000, tokenBudget: 8000 },
        { provider: "brave", maxRetries: 1, timeBudgetMs: 120000, tokenBudget: 8000 }
      ]
    });
    expect(run.status).toBe("running");
    expect(run.children.length).toBe(2);

    await store.assignChildJob(run.id, "openai", "job-1");
    await store.assignChildJob(run.id, "brave", "job-2");

    const running = await store.updateChildByJob("job-1", {
      status: "running",
      summary: "searching"
    });
    expect(running?.run.status).toBe("running");

    await store.updateChildByJob("job-1", {
      status: "succeeded",
      summary: "done"
    });
    const done = await store.updateChildByJob("job-2", {
      status: "succeeded",
      summary: "done"
    });

    expect(done?.run.status).toBe("completed");
    expect(done?.transitionedToTerminal).toBe(true);
    expect(store.summarize(done!.run)).toContain("status=completed");
  });
});

