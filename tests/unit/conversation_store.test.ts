import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../../apps/gateway-orchestrator/src/builtins/conversation_store";

describe("ConversationStore", () => {
  it("stores enriched events and returns recent slices", async () => {
    const stateDir = path.join(os.tmpdir(), `alfred-conversations-${Date.now()}`);
    const store = new ConversationStore(stateDir, 100);
    await store.ensureReady();

    await store.add("s1@s.whatsapp.net", "inbound", "/alfred hello", {
      source: "whatsapp",
      channel: "baileys",
      kind: "chat"
    });
    await store.add("s1@s.whatsapp.net", "outbound", "Hi there", {
      source: "gateway",
      channel: "internal",
      kind: "chat"
    });
    await store.add("system", "system", "Gateway started", {
      source: "system",
      channel: "internal",
      kind: "status"
    });

    const recent = await store.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.text).toBe("Hi there");
    expect(recent[1]?.kind).toBe("status");

    const bySession = await store.listBySession("s1@s.whatsapp.net", 10);
    expect(bySession).toHaveLength(2);
    expect(bySession[0]?.direction).toBe("inbound");
    expect(bySession[1]?.direction).toBe("outbound");
  });
});
