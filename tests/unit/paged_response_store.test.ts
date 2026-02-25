import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PagedResponseStore } from "../../apps/gateway-orchestrator/src/builtins/paged_response_store";

describe("PagedResponseStore", () => {
  it("stores and pops paged responses by session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-paged-store-unit-"));
    const store = new PagedResponseStore(stateDir);
    await store.ensureReady();

    await store.setPages("owner@s.whatsapp.net", ["page two", "page three"]);

    const first = await store.popNext("owner@s.whatsapp.net");
    expect(first).toEqual({ page: "page two", remaining: 1 });

    const second = await store.popNext("owner@s.whatsapp.net");
    expect(second).toEqual({ page: "page three", remaining: 0 });

    const third = await store.popNext("owner@s.whatsapp.net");
    expect(third).toBeNull();
  });
});
