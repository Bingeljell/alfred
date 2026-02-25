import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryCheckpointService } from "../../apps/gateway-orchestrator/src/builtins/memory_checkpoint_service";

describe("MemoryCheckpointService", () => {
  it("writes checkpoints and enforces duplicate/day-limit guards", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-memory-checkpoints-unit-"));
    const appendMemoryNote = vi.fn().mockResolvedValue({ path: "memory/2026-02-25.md" });
    const syncMemory = vi.fn().mockResolvedValue(undefined);
    const service = new MemoryCheckpointService(stateDir, {
      memoryService: { appendMemoryNote, syncMemory },
      defaultConfig: {
        maxEntriesPerDay: 2,
        dedupeWindowMs: 24 * 60 * 60 * 1000
      }
    });
    await service.ensureReady();

    const first = await service.checkpoint({
      sessionId: "owner@s.whatsapp.net",
      class: "decision",
      source: "approval_execute",
      summary: "Approved web search action",
      dedupeKey: "decision-1",
      day: "2026-02-25"
    });
    expect(first).toEqual({ written: true, reason: "written", day: "2026-02-25" });
    expect(appendMemoryNote).toHaveBeenCalledTimes(1);
    expect(String(appendMemoryNote.mock.calls[0]?.[0] ?? "")).toContain("class: decision");

    const duplicate = await service.checkpoint({
      sessionId: "owner@s.whatsapp.net",
      class: "decision",
      source: "approval_execute",
      summary: "Approved web search action",
      dedupeKey: "decision-1",
      day: "2026-02-25"
    });
    expect(duplicate).toEqual({ written: false, reason: "duplicate" });

    const second = await service.checkpoint({
      sessionId: "owner@s.whatsapp.net",
      class: "todo",
      source: "task_add",
      summary: "Task added: follow up",
      dedupeKey: "todo-2",
      day: "2026-02-25"
    });
    expect(second).toEqual({ written: true, reason: "written", day: "2026-02-25" });

    const limited = await service.checkpoint({
      sessionId: "owner@s.whatsapp.net",
      class: "fact",
      source: "worker_notification",
      summary: "Job completed",
      dedupeKey: "fact-3",
      day: "2026-02-25"
    });
    expect(limited).toEqual({ written: false, reason: "daily_limit" });

    const status = await service.status();
    expect(status.runtime.writeCount).toBe(2);
    expect(status.runtime.skippedDuplicateCount).toBe(1);
    expect(status.runtime.skippedDailyLimitCount).toBe(1);
    expect(syncMemory).toHaveBeenCalledTimes(0);
  });

  it("syncs memory on write when configured", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-memory-checkpoints-sync-unit-"));
    const appendMemoryNote = vi.fn().mockResolvedValue({ path: "memory/2026-02-25.md" });
    const syncMemory = vi.fn().mockResolvedValue(undefined);
    const service = new MemoryCheckpointService(stateDir, {
      memoryService: { appendMemoryNote, syncMemory },
      defaultConfig: { syncOnWrite: true }
    });
    await service.ensureReady();

    const result = await service.checkpoint({
      sessionId: "owner@s.whatsapp.net",
      class: "fact",
      source: "worker_notification",
      summary: "Job completed"
    });
    expect(result.written).toBe(true);
    expect(syncMemory).toHaveBeenCalledTimes(1);
  });
});
