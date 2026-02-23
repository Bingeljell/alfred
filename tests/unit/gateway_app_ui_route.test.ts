import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayApp } from "../../apps/gateway-orchestrator/src/app";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { MessageDedupeStore } from "../../apps/gateway-orchestrator/src/whatsapp/dedupe_store";

describe("gateway web console routes", () => {
  it("registers root and /ui routes", () => {
    const stateDir = path.join(os.tmpdir(), `alfred-ui-route-unit-${Date.now()}`);
    const store = new FileBackedQueueStore(stateDir);
    const dedupeStore = new MessageDedupeStore(stateDir);
    const app = createGatewayApp(store, { dedupeStore });
    const stack = ((app as unknown as { router?: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }).router?.stack ?? []);
    const routes = stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route?.methods ?? {}).map((method) => `${method.toUpperCase()} ${layer.route?.path}`)
      );

    expect(routes).toContain("GET /");
    expect(routes).toContain("GET /ui");
    expect(routes).toContain("POST /v1/auth/openai/start");
    expect(routes).toContain("GET /v1/auth/openai/status");
    expect(routes).toContain("GET /v1/auth/openai/rate-limits");
    expect(routes).toContain("POST /v1/auth/openai/disconnect");
    expect(routes).toContain("GET /v1/whatsapp/live/status");
    expect(routes).toContain("POST /v1/whatsapp/live/connect");
    expect(routes).toContain("POST /v1/whatsapp/live/disconnect");
    expect(routes).toContain("GET /v1/stream/events");
    expect(routes).toContain("GET /v1/stream/events/subscribe");
    expect(routes).toContain("GET /v1/identity/mappings");
    expect(routes).toContain("GET /v1/identity/resolve");
    expect(routes).toContain("POST /v1/identity/mappings");
    expect(routes).toContain("GET /v1/auth/openai/callback");
  });
});
