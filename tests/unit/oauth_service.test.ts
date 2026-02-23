import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OAuthService } from "../../apps/gateway-orchestrator/src/auth/oauth_service";

describe("OAuthService", () => {
  it("completes mock oauth flow and persists connection status", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-oauth-unit-"));
    const service = new OAuthService({
      stateDir,
      publicBaseUrl: "http://localhost:3000",
      openai: { mode: "mock" }
    });

    await service.ensureReady();
    const started = await service.startOpenAiConnect("owner@s.whatsapp.net");
    expect(started.mode).toBe("mock");
    expect(started.authorizationUrl).toContain("/v1/auth/openai/mock/authorize");

    const completed = await service.completeOpenAiCallback({
      state: started.state,
      code: "allow-1"
    });

    expect(completed.connected).toBe(true);
    const accessToken = await service.getOpenAiAccessToken("owner@s.whatsapp.net");
    expect(accessToken).toContain("mock_access_allow-1");

    const status = await service.statusOpenAi("owner@s.whatsapp.net");
    expect(status.connected).toBe(true);
    expect(status.mode).toBe("mock");

    const removed = await service.disconnectOpenAi("owner@s.whatsapp.net");
    expect(removed).toBe(true);

    const after = await service.statusOpenAi("owner@s.whatsapp.net");
    expect(after.connected).toBe(false);
  });

  it("rejects callback with invalid state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-oauth-unit-invalid-"));
    const service = new OAuthService({
      stateDir,
      publicBaseUrl: "http://localhost:3000",
      openai: { mode: "mock" }
    });

    await service.ensureReady();
    await expect(
      service.completeOpenAiCallback({
        state: "bad-state",
        code: "allow-2"
      })
    ).rejects.toThrow("oauth_state_invalid_or_expired");
  });

  it("stores encrypted tokens when encryption key is provided", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-oauth-unit-secure-"));
    const service = new OAuthService({
      stateDir,
      publicBaseUrl: "http://localhost:3000",
      encryptionKey: "local-secret-for-tests",
      openai: { mode: "mock" }
    });

    await service.ensureReady();
    const started = await service.startOpenAiConnect("owner@s.whatsapp.net");
    await service.completeOpenAiCallback({
      state: started.state,
      code: "allow-3"
    });

    const status = await service.statusOpenAi("owner@s.whatsapp.net");
    expect(status.storageScheme).toBe("aes-256-gcm");
  });
});
