import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IdentityProfileStore } from "../../apps/gateway-orchestrator/src/auth/identity_profile_store";

describe("IdentityProfileStore", () => {
  it("persists explicit mappings and resolves defaults", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-identity-map-unit-"));
    const store = new IdentityProfileStore(stateDir);
    await store.ensureReady();

    const explicit = await store.setMapping("12345@s.whatsapp.net", "team-profile-a");
    expect(explicit.whatsAppJid).toBe("12345@s.whatsapp.net");
    expect(explicit.authSessionId).toBe("team-profile-a");

    const resolvedExplicit = await store.resolveAuthSession("12345@s.whatsapp.net");
    expect(resolvedExplicit).toBe("team-profile-a");

    const resolvedDefault = await store.resolveAuthSession("99999@s.whatsapp.net");
    expect(resolvedDefault).toBe("99999@s.whatsapp.net");

    const listing = await store.listMappings(10);
    expect(listing.map((item) => item.whatsAppJid)).toContain("12345@s.whatsapp.net");
    expect(listing.map((item) => item.whatsAppJid)).toContain("99999@s.whatsapp.net");
  });
});
