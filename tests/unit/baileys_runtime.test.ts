import { describe, expect, it } from "vitest";
import { BaileysRuntime } from "../../apps/gateway-orchestrator/src/whatsapp/baileys_runtime";

type Listener = (payload: unknown) => void;

function createFakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: Array<{ jid: string; text: string }> = [];

  const socket = {
    ev: {
      on: (event: string, listener: Listener) => {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      }
    },
    sendMessage: async (jid: string, payload: { text: string }) => {
      sent.push({ jid, text: payload.text });
    },
    end: () => undefined,
    logout: async () => undefined,
    user: { id: "12345@s.whatsapp.net" }
  };

  function emit(event: string, payload: unknown) {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  return { socket, sent, emit };
}

describe("BaileysRuntime", () => {
  it("rejects invalid outbound jid and forwards valid messages", async () => {
    const fake = createFakeSocket();
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      onInbound: async () => undefined,
      moduleLoader: async () => ({
        default: () => fake.socket,
        fetchLatestBaileysVersion: async () => ({ version: [1, 0, 0] as [number, number, number] }),
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined })
      })
    });

    await runtime.connect();
    fake.emit("connection.update", { connection: "open" });

    await expect(runtime.sendText("not-a-jid", "hi")).rejects.toThrow("baileys_invalid_jid");
    await runtime.sendText("12345@s.whatsapp.net", "hello");

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.jid).toBe("12345@s.whatsapp.net");
    expect(fake.sent[0]?.text).toBe("hello");
  });

  it("forwards only allowed inbound messages and truncates text", async () => {
    const fake = createFakeSocket();
    const received: Array<{ remoteJid: string; text: string }> = [];
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      maxTextChars: 8,
      onInbound: async (message) => {
        received.push({
          remoteJid: message.key.remoteJid,
          text: message.message?.conversation ?? ""
        });
      },
      moduleLoader: async () => ({
        default: () => fake.socket,
        fetchLatestBaileysVersion: async () => ({ version: [1, 0, 0] as [number, number, number] }),
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined })
      })
    });

    await runtime.connect();
    fake.emit("messages.upsert", {
      messages: [
        {
          key: { id: "a", remoteJid: "group@g.us", fromMe: false },
          message: { conversation: "ignore group" }
        },
        {
          key: { id: "b", remoteJid: "12345@s.whatsapp.net", fromMe: true },
          message: { conversation: "ignore from me" }
        },
        {
          key: { id: "c", remoteJid: "67890@s.whatsapp.net", fromMe: false },
          message: { conversation: "1234567890" }
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.remoteJid).toBe("67890@s.whatsapp.net");
    expect(received[0]?.text).toBe("12345678");
  });
});
