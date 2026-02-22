import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MessageDedupeStore } from "../../apps/gateway-orchestrator/src/whatsapp/dedupe_store";

describe("MessageDedupeStore", () => {
  it("marks first key as new and second as duplicate", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-dedupe-test-"));
    const store = new MessageDedupeStore(stateDir, 60_000);

    const first = await store.isDuplicateAndMark("baileys:jid:1", 1000);
    const second = await store.isDuplicateAndMark("baileys:jid:1", 1001);

    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it("expires keys after ttl", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-dedupe-expire-"));
    const store = new MessageDedupeStore(stateDir, 100);

    await store.isDuplicateAndMark("baileys:jid:2", 1000);
    const afterExpiry = await store.isDuplicateAndMark("baileys:jid:2", 1200);

    expect(afterExpiry).toBe(false);
  });
});
