import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/gateway-orchestrator/src/config";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.workerPollMs).toBe(250);
    expect(config.stateDir.length).toBeGreaterThan(0);
  });

  it("parses custom env values", () => {
    const config = loadConfig({
      PORT: "4010",
      STATE_DIR: "./tmp/state-a",
      WORKER_POLL_MS: "500"
    });

    expect(config.port).toBe(4010);
    expect(config.workerPollMs).toBe(500);
    expect(config.stateDir.endsWith("tmp/state-a")).toBe(true);
  });

  it("fails on invalid values", () => {
    expect(() =>
      loadConfig({
        PORT: "99999"
      })
    ).toThrow();
  });
});
