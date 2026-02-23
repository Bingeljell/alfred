import { describe, expect, it } from "vitest";
import { BaileysRuntime } from "../../apps/gateway-orchestrator/src/whatsapp/baileys_runtime";

type Listener = (payload: unknown) => void;

function createFakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: Array<{ jid: string; text: string }> = [];
  const counters = {
    logoutCalls: 0,
    endCalls: 0
  };

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
    end: () => {
      counters.endCalls += 1;
    },
    logout: async () => {
      counters.logoutCalls += 1;
    },
    user: { id: "12345@s.whatsapp.net" }
  };

  function emit(event: string, payload: unknown) {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  return { socket, sent, emit, counters };
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
    fake.emit("connection.update", { connection: "open" });
    fake.emit("messages.upsert", {
      type: "notify",
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

  it("enforces sender allowlist and required prefix; supports self messages when enabled", async () => {
    const fake = createFakeSocket();
    const received: Array<{ remoteJid: string; text: string }> = [];
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      allowSelfFromMe: true,
      requirePrefix: "/alfred",
      allowedSenders: ["11111@s.whatsapp.net"],
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
    fake.emit("connection.update", { connection: "open" });
    fake.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "a1", remoteJid: "99999@s.whatsapp.net", fromMe: false },
          message: { conversation: "/alfred ignored-not-allowlisted" }
        },
        {
          key: { id: "a2", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "no-prefix" }
        },
        {
          key: { id: "a3", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "/alfred run report" }
        },
        {
          key: { id: "a4", remoteJid: "11111@s.whatsapp.net", fromMe: true },
          message: { conversation: "/alfred self check" }
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(2);
    expect(received[0]?.text).toBe("run report");
    expect(received[1]?.text).toBe("self check");
  });

  it("filters non-notify upserts and stale messages to reduce history-sync noise", async () => {
    const fake = createFakeSocket();
    const received: Array<{ remoteJid: string; text: string }> = [];
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      historyGraceWindowSec: 0,
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
    fake.emit("connection.update", { connection: "open" });
    const nowSeconds = Math.floor(Date.now() / 1000);
    fake.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "h1", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "history" },
          messageTimestamp: nowSeconds
        }
      ]
    });
    fake.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "s1", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "stale" },
          messageTimestamp: nowSeconds - 120
        },
        {
          key: { id: "l1", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "live" },
          messageTimestamp: nowSeconds + 1
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("live");

    const status = runtime.status() as {
      acceptedMessageCount: number;
      ignoredNonNotifyCount: number;
      ignoredStaleCount: number;
    };
    expect(status.acceptedMessageCount).toBe(1);
    expect(status.ignoredNonNotifyCount).toBe(1);
    expect(status.ignoredStaleCount).toBe(1);
  });

  it("deduplicates already-seen inbound message ids", async () => {
    const fake = createFakeSocket();
    const received: string[] = [];
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      allowSelfFromMe: true,
      onInbound: async (message) => {
        received.push(message.message?.conversation ?? "");
      },
      moduleLoader: async () => ({
        default: () => fake.socket,
        fetchLatestBaileysVersion: async () => ({ version: [1, 0, 0] as [number, number, number] }),
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined })
      })
    });

    await runtime.connect();
    fake.emit("connection.update", { connection: "open" });
    const nowSeconds = Math.floor(Date.now() / 1000);
    fake.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "dup-1", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "first" },
          messageTimestamp: nowSeconds
        }
      ]
    });
    fake.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "dup-1", remoteJid: "11111@s.whatsapp.net", fromMe: false },
          message: { conversation: "first duplicate" },
          messageTimestamp: nowSeconds
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["first"]);

    const status = runtime.status() as { ignoredDuplicateCount: number };
    expect(status.ignoredDuplicateCount).toBe(1);
  });

  it("locks QR linking after max generation count and requires manual reconnect", async () => {
    const fake = createFakeSocket();
    const runtime = new BaileysRuntime({
      authDir: "/tmp/baileys-auth",
      maxQrGenerations: 3,
      onInbound: async () => undefined,
      moduleLoader: async () => ({
        default: () => fake.socket,
        fetchLatestBaileysVersion: async () => ({ version: [1, 0, 0] as [number, number, number] }),
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined })
      })
    });

    await runtime.connect();
    fake.emit("connection.update", { connection: "connecting", qr: "qr-1" });
    fake.emit("connection.update", { connection: "connecting", qr: "qr-2" });
    fake.emit("connection.update", { connection: "connecting", qr: "qr-3" });
    fake.emit("connection.update", { connection: "connecting", qr: "qr-4" });

    const status = runtime.status() as {
      connected: boolean;
      qr: string | null;
      qrGenerationCount: number;
      qrGenerationLimit: number;
      qrLocked: boolean;
      lastError: string | null;
    };
    expect(status.connected).toBe(false);
    expect(status.qr).toBeNull();
    expect(status.qrGenerationCount).toBe(3);
    expect(status.qrGenerationLimit).toBe(3);
    expect(status.qrLocked).toBe(true);
    expect(status.lastError).toBe("baileys_qr_generation_limit_reached");
  });

  it("keeps auth session on runtime stop (no logout)", async () => {
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
    await runtime.stop();

    expect(fake.counters.logoutCalls).toBe(0);
    expect(fake.counters.endCalls).toBeGreaterThan(0);
  });
});
