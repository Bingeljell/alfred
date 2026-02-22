import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../../apps/gateway-orchestrator/src/gateway_service";
import { startNotificationDispatcher } from "../../apps/gateway-orchestrator/src/notification_dispatcher";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";
import { MessageDedupeStore } from "../../apps/gateway-orchestrator/src/whatsapp/dedupe_store";
import { FileBackedQueueStore } from "../../apps/gateway-orchestrator/src/local_queue_store";
import { startWorker } from "../../apps/worker/src/worker";
import { InMemoryWhatsAppAdapter } from "../../packages/provider-adapters/src";
import { waitFor } from "../helpers/wait_for";

describe("phase 2 smoke", () => {
  it("handles baileys inbound + async updates while chat remains responsive", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-phase2-smoke-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    const dedupeStore = new MessageDedupeStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    const service = new GatewayService(queueStore);
    const adapter = new InMemoryWhatsAppAdapter();

    await queueStore.ensureReady();
    await dedupeStore.ensureReady();
    await notificationStore.ensureReady();

    const worker = startWorker({
      store: queueStore,
      pollIntervalMs: 10,
      workerId: "worker-phase2-smoke",
      onStatusChange: async (event) => {
        if (!event.sessionId) {
          return;
        }
        await notificationStore.enqueue({
          sessionId: event.sessionId,
          jobId: event.jobId,
          status: event.status,
          text: `Job ${event.jobId} is ${event.status}`
        });
      }
    });

    const dispatcher = startNotificationDispatcher({
      store: notificationStore,
      adapter,
      pollIntervalMs: 10
    });

    const inbound = await service.handleBaileysInbound(
      {
        key: { id: "smoke-1", remoteJid: "owner@s.whatsapp.net" },
        message: { conversation: "/job run phase2 smoke" }
      },
      dedupeStore
    );

    expect(inbound.mode).toBe("async-job");

    const immediateChat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "still there?",
      requestJob: false
    });

    expect(immediateChat.mode).toBe("chat");
    expect(immediateChat.response).toBe("ack:still there?");

    await waitFor(async () => {
      const status = adapter.sent.find((entry) => entry.jobId === inbound.jobId && entry.status === "succeeded");
      return status ?? null;
    });

    await worker.stop();
    await dispatcher.stop();
  });
});
