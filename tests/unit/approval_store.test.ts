import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../../apps/gateway-orchestrator/src/builtins/approval_store";

describe("ApprovalStore", () => {
  it("supports latest pending lookup and consume/discard", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-approval-store-"));
    const store = new ApprovalStore(stateDir);
    await store.ensureReady();

    const first = await store.create("owner@s.whatsapp.net", "send_text", { text: "one" });
    const second = await store.create("owner@s.whatsapp.net", "send_text", { text: "two" });
    expect(first.token).not.toBe(second.token);

    const latest = await store.peekLatest("owner@s.whatsapp.net");
    expect(latest?.token).toBe(second.token);

    const discarded = await store.discardLatest("owner@s.whatsapp.net");
    expect(discarded?.token).toBe(second.token);

    const consumed = await store.consumeLatest("owner@s.whatsapp.net");
    expect(consumed?.token).toBe(first.token);

    const empty = await store.peekLatest("owner@s.whatsapp.net");
    expect(empty).toBeNull();
  });

  it("lists pending approvals by session and globally", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-approval-store-list-"));
    const store = new ApprovalStore(stateDir);
    await store.ensureReady();

    const first = await store.create("a@s.whatsapp.net", "send_text", { text: "one" });
    await store.create("b@s.whatsapp.net", "send_text", { text: "two" });
    const third = await store.create("a@s.whatsapp.net", "web_search", { query: "latest docs" });

    const bySession = await store.listBySession("a@s.whatsapp.net", 10);
    expect(bySession.length).toBe(2);
    expect(bySession[0]?.token).toBe(third.token);
    expect(bySession[1]?.token).toBe(first.token);

    const globalPending = await store.listPending(10);
    expect(globalPending.length).toBe(3);
  });
});
