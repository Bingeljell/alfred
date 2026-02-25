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

  it("notifies subscribers on appended events", async () => {
    const stateDir = path.join(os.tmpdir(), `alfred-conversations-sub-${Date.now()}`);
    const store = new ConversationStore(stateDir, 100);
    await store.ensureReady();

    const seen: string[] = [];
    const unsubscribe = store.subscribe((event) => {
      seen.push(event.text);
    });

    await store.add("s2@s.whatsapp.net", "inbound", "first");
    await store.add("s2@s.whatsapp.net", "outbound", "second");
    unsubscribe();
    await store.add("s2@s.whatsapp.net", "outbound", "third");

    expect(seen).toEqual(["first", "second"]);
  });

  it("supports query filtering and suppresses noisy duplicates in window", async () => {
    const stateDir = path.join(os.tmpdir(), `alfred-conversations-filter-${Date.now()}`);
    const store = new ConversationStore(stateDir, { maxEvents: 100, retentionDays: 14, dedupeWindowMs: 10_000 });
    await store.ensureReady();

    const first = await store.add("s3@s.whatsapp.net", "inbound", "same-text", {
      source: "whatsapp",
      channel: "baileys",
      kind: "chat"
    });
    await store.add("s3@s.whatsapp.net", "inbound", "same-text", {
      source: "whatsapp",
      channel: "baileys",
      kind: "chat"
    });
    const second = await store.add("s3@s.whatsapp.net", "outbound", "job started", {
      source: "gateway",
      channel: "internal",
      kind: "job"
    });

    const queried = await store.query({
      sessionId: "s3@s.whatsapp.net",
      kinds: ["chat"],
      sources: ["whatsapp"],
      limit: 10
    });

    expect(queried).toHaveLength(1);
    expect(queried[0]?.text).toBe("same-text");

    const bounded = await store.query({
      sessionId: "s3@s.whatsapp.net",
      kinds: ["chat", "job"],
      since: first.createdAt,
      until: second.createdAt,
      limit: 10
    });
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.kind).toBe("chat");
  });
});
