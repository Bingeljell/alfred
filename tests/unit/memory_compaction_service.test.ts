import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationStore } from "../../apps/gateway-orchestrator/src/builtins/conversation_store";
import { MemoryCompactionService } from "../../apps/gateway-orchestrator/src/builtins/memory_compaction_service";

function tempStateDir(tag: string): string {
  return path.join(os.tmpdir(), `alfred-memory-compaction-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function rewriteEventTimestamps(
  stateDir: string,
  timestampsById: Record<string, string>
): Promise<void> {
  const filePath = path.join(stateDir, "builtins", "conversations.json");
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    events: Array<{
      id: string;
      createdAt: string;
    }>;
  };

  for (const event of parsed.events) {
    const next = timestampsById[event.id];
    if (next) {
      event.createdAt = next;
    }
  }

  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");
}

describe("MemoryCompactionService", () => {
  it("compacts previous-day conversation events into memory once and advances cursor", async () => {
    const stateDir = tempStateDir("compacts");
    const conversationStore = new ConversationStore(stateDir, { maxEvents: 1000 });
    await conversationStore.ensureReady();

    const created = [];
    created.push(
      await conversationStore.add("111@s.whatsapp.net", "inbound", "hello"),
      await conversationStore.add("111@s.whatsapp.net", "outbound", "hi there"),
      await conversationStore.add("111@s.whatsapp.net", "inbound", "/web weather"),
      await conversationStore.add("111@s.whatsapp.net", "outbound", "working on it"),
      await conversationStore.add("222@s.whatsapp.net", "inbound", "set reminder for meds"),
      await conversationStore.add("222@s.whatsapp.net", "outbound", "Reminder created (r1)")
    );

    await rewriteEventTimestamps(stateDir, {
      [created[0].id]: "2026-02-24T01:00:00.000Z",
      [created[1].id]: "2026-02-24T01:01:00.000Z",
      [created[2].id]: "2026-02-24T01:02:00.000Z",
      [created[3].id]: "2026-02-24T01:03:00.000Z",
      [created[4].id]: "2026-02-24T01:04:00.000Z",
      [created[5].id]: "2026-02-24T01:05:00.000Z"
    });

    const appendMemoryNote = vi.fn(async (_text: string, _date?: string) => ({ path: "memory/2026-02-24.md" }));
    const syncMemory = vi.fn(async () => {});
    const service = new MemoryCompactionService(stateDir, {
      conversationStore,
      memoryService: {
        appendMemoryNote,
        syncMemory
      },
      defaultConfig: {
        minEventsPerDay: 6,
        maxEventsPerDay: 100,
        sessionId: "owner@s.whatsapp.net"
      }
    });

    await service.ensureReady();
    const first = await service.runNow({
      force: true,
      trigger: "test_compaction",
      now: new Date("2026-02-25T12:00:00.000Z")
    });

    expect(first.runtime.lastOutcome).toBe("compacted");
    expect(first.runtime.lastCompactedDate).toBe("2026-02-24");
    expect(appendMemoryNote).toHaveBeenCalledTimes(1);
    expect(syncMemory).toHaveBeenCalledTimes(1);
    const noteText = String(appendMemoryNote.mock.calls[0]?.[0] ?? "");
    const noteDate = String(appendMemoryNote.mock.calls[0]?.[1] ?? "");
    expect(noteDate).toBe("2026-02-24");
    expect(noteText).toContain("[memory-compaction] Daily conversation digest");
    expect(noteText).toContain("commands_seen: /web=1");

    const second = await service.runNow({
      force: true,
      trigger: "test_compaction_repeat",
      now: new Date("2026-02-25T12:10:00.000Z")
    });

    expect(second.runtime.lastOutcome).toBe("skipped");
    expect(second.runtime.lastSkipReason).toBe("already_processed");
    expect(appendMemoryNote).toHaveBeenCalledTimes(1);
  });

  it("skips day when events are below configured minimum", async () => {
    const stateDir = tempStateDir("skip-low-signal");
    const conversationStore = new ConversationStore(stateDir, { maxEvents: 1000 });
    await conversationStore.ensureReady();

    const one = await conversationStore.add("111@s.whatsapp.net", "inbound", "one");
    const two = await conversationStore.add("111@s.whatsapp.net", "outbound", "two");
    await rewriteEventTimestamps(stateDir, {
      [one.id]: "2026-02-24T02:00:00.000Z",
      [two.id]: "2026-02-24T02:01:00.000Z"
    });

    const appendMemoryNote = vi.fn(async (_text: string, _date?: string) => ({ path: "memory/2026-02-24.md" }));
    const syncMemory = vi.fn(async () => {});
    const service = new MemoryCompactionService(stateDir, {
      conversationStore,
      memoryService: { appendMemoryNote, syncMemory },
      defaultConfig: {
        minEventsPerDay: 3,
        maxEventsPerDay: 100
      }
    });

    await service.ensureReady();
    const status = await service.runNow({
      force: true,
      trigger: "test_low_signal",
      now: new Date("2026-02-25T12:00:00.000Z")
    });

    expect(status.runtime.lastOutcome).toBe("skipped");
    expect(status.runtime.lastSkipReason).toBe("insufficient_signal");
    expect(status.runtime.skippedNoDataDayCount).toBe(1);
    expect(appendMemoryNote).toHaveBeenCalledTimes(0);
    expect(syncMemory).toHaveBeenCalledTimes(0);
  });

  it("marks invalid manual target date as error", async () => {
    const stateDir = tempStateDir("invalid-target");
    const conversationStore = new ConversationStore(stateDir, { maxEvents: 1000 });
    await conversationStore.ensureReady();

    const service = new MemoryCompactionService(stateDir, {
      conversationStore,
      memoryService: {
        appendMemoryNote: async () => ({ path: "memory/2026-02-24.md" }),
        syncMemory: async () => {}
      }
    });

    await service.ensureReady();
    const status = await service.runNow({
      force: true,
      targetDate: "not-a-date",
      trigger: "test_invalid_target",
      now: new Date("2026-02-25T12:00:00.000Z")
    });

    expect(status.runtime.lastOutcome).toBe("error");
    expect(status.runtime.lastError).toBe("invalid_target_date");
  });
});
