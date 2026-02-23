import { describe, expect, it } from "vitest";
import { withQrImageData } from "../../apps/gateway-orchestrator/src/app";

describe("withQrImageData", () => {
  it("adds qrImageDataUrl when qr payload is present", async () => {
    const payload = {
      provider: "baileys",
      state: "connecting",
      connected: false,
      qr: "test-qr-payload"
    };

    const output = (await withQrImageData(payload)) as {
      qr: string;
      qrImageDataUrl: string | null;
    };

    expect(output.qr).toBe("test-qr-payload");
    expect(typeof output.qrImageDataUrl).toBe("string");
    expect(output.qrImageDataUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("returns null qrImageDataUrl when no qr payload is present", async () => {
    const payload = {
      provider: "baileys",
      state: "disconnected",
      connected: false,
      qr: null
    };

    const output = (await withQrImageData(payload)) as {
      qr: string | null;
      qrImageDataUrl: string | null;
    };

    expect(output.qr).toBeNull();
    expect(output.qrImageDataUrl).toBeNull();
  });
});
