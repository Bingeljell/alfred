import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";

describe("tool manifest routes", () => {
  it("returns runtime manifest and compact manifest from gateway service", async () => {
    const stateDir = path.join(os.tmpdir(), `alfred-tool-manifest-unit-${Date.now()}`);
    const store = new FileBackedQueueStore(stateDir);
    await store.ensureReady();
    const service = new GatewayService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "chatgpt");

    const tools = service.getRuntimeToolManifest({
      sessionId: "owner@s.whatsapp.net",
      authSessionId: "owner@s.whatsapp.net"
    }) as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    const webSearch = tools.find((item) => item.actionType === "web.search");
    expect(webSearch).toBeTruthy();
    expect(webSearch?.toolId).toBe("web.search");
    expect(webSearch?.allowed).toBe(true);
    expect(webSearch?.executionPlane).toBe("either");

    const compactTools = service.getRuntimeToolManifestCompact({
      sessionId: "owner@s.whatsapp.net",
      authSessionId: "owner@s.whatsapp.net"
    }) as Array<Record<string, unknown>>;
    expect(Array.isArray(compactTools)).toBe(true);
    const hasWorkerRun = compactTools.some((item) => item.actionType === "worker.run");
    expect(hasWorkerRun).toBe(true);
  });
});
