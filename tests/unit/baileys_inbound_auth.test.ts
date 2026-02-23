import { describe, expect, it } from "vitest";
import { isAuthorizedBaileysInbound } from "../../apps/gateway-orchestrator/src/app";

describe("isAuthorizedBaileysInbound", () => {
  it("allows requests when no token is configured", () => {
    expect(isAuthorizedBaileysInbound(undefined, undefined)).toBe(true);
    expect(isAuthorizedBaileysInbound(undefined, "anything")).toBe(true);
  });

  it("requires exact token match when configured", () => {
    expect(isAuthorizedBaileysInbound("secret", undefined)).toBe(false);
    expect(isAuthorizedBaileysInbound("secret", "wrong")).toBe(false);
    expect(isAuthorizedBaileysInbound("secret", " secret ")).toBe(true);
    expect(isAuthorizedBaileysInbound("secret", "secret")).toBe(true);
  });
});
