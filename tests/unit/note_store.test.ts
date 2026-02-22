import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NoteStore } from "../../apps/gateway-orchestrator/src/builtins/note_store";

describe("NoteStore", () => {
  it("adds and lists notes by session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-note-store-"));
    const store = new NoteStore(stateDir);

    await store.ensureReady();
    const one = await store.add("owner@s.whatsapp.net", "First note");
    const two = await store.add("owner@s.whatsapp.net", "Second note");

    const list = await store.listBySession("owner@s.whatsapp.net");

    expect(list.length).toBe(2);
    expect(list[0].id).toBe(one.id);
    expect(list[1].id).toBe(two.id);
  });
});
