import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OAuthService } from "../../apps/gateway-orchestrator/src/auth/oauth_service";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";

describe("oauth command integration", () => {
  it("supports chat command connect/status/disconnect flow", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-oauth-int-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    await queueStore.ensureReady();

    const oauth = new OAuthService({
      stateDir,
      publicBaseUrl: "http://localhost:3000",
      openai: { mode: "mock" }
    });
    await oauth.ensureReady();

    const service = new GatewayService(queueStore, undefined, undefined, undefined, undefined, undefined, oauth);

    const before = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/auth status",
      requestJob: false
    });
    expect(before.response).toContain("not connected");

    const started = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/auth connect",
      requestJob: false
    });
    expect(started.response).toContain("connect OpenAI");
    const connectUrl = String(started.response?.split(" ").at(-1) ?? "");
    const startedUrl = new URL(connectUrl);
    const pendingState = startedUrl.searchParams.get("state");
    expect(pendingState).toBeTruthy();

    await oauth.completeOpenAiCallback({
      state: String(pendingState),
      code: "allow-integration"
    });

    const after = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/auth status",
      requestJob: false
    });
    expect(after.response).toContain("connected");

    const disconnected = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "/auth disconnect",
      requestJob: false
    });
    expect(disconnected.response).toContain("token removed");
  });
});
