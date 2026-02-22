import { describe, expect, it } from "vitest";
import { normalizeBaileysInbound } from "../../apps/gateway-orchestrator/src/whatsapp/normalize_baileys";

describe("normalizeBaileysInbound", () => {
  it("normalizes plain chat messages", () => {
    const normalized = normalizeBaileysInbound({
      key: { id: "m-1", remoteJid: "user@s.whatsapp.net" },
      message: { conversation: "hello world" },
      pushName: "Nikhil"
    });

    expect(normalized.dedupeKey).toBe("baileys:user@s.whatsapp.net:m-1");
    expect(normalized.normalized.requestJob).toBe(false);
    expect(normalized.normalized.text).toBe("hello world");
  });

  it("normalizes /job messages as async requests", () => {
    const normalized = normalizeBaileysInbound({
      key: { id: "m-2", remoteJid: "user@s.whatsapp.net" },
      message: { extendedTextMessage: { text: "/job split this video" } }
    });

    expect(normalized.normalized.requestJob).toBe(true);
    expect(normalized.normalized.text).toBe("split this video");
  });
});
