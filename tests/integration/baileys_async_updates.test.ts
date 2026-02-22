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

describe("baileys async integration", () => {
  it("dedupes inbound events and pushes async job status updates", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-baileys-int-"));
    const queueStore = new FileBackedQueueStore(stateDir);
    const dedupeStore = new MessageDedupeStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    const service = new GatewayService(queueStore);
    const adapter = new InMemoryWhatsAppAdapter();

    await queueStore.ensureReady();
    await dedupeStore.ensureReady();
    await notificationStore.ensureReady();

    const dispatcher = startNotificationDispatcher({
      store: notificationStore,
      adapter,
      pollIntervalMs: 10
    });

    const worker = startWorker({
      store: queueStore,
      pollIntervalMs: 10,
      workerId: "worker-baileys-int",
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

    const first = await service.handleBaileysInbound(
      {
        key: { id: "msg-1", remoteJid: "owner@s.whatsapp.net" },
        message: { conversation: "/job prepare proposal" }
      },
      dedupeStore
    );

    expect(first.duplicate).toBe(false);
    expect(first.mode).toBe("async-job");
    expect(first.jobId).toBeTruthy();

    const chat = await service.handleInbound({
      sessionId: "owner@s.whatsapp.net",
      text: "what are you doing?",
      requestJob: false
    });

    expect(chat.mode).toBe("chat");
    expect(chat.response).toBe("ack:what are you doing?");

    const second = await service.handleBaileysInbound(
      {
        key: { id: "msg-1", remoteJid: "owner@s.whatsapp.net" },
        message: { conversation: "/job prepare proposal" }
      },
      dedupeStore
    );

    expect(second.duplicate).toBe(true);

    const completed = await waitFor(async () => {
      const job = await service.getJob(first.jobId as string);
      if (!job || job.status !== "succeeded") {
        return null;
      }
      return job;
    });

    expect(completed.status).toBe("succeeded");

    const sentStatus = await waitFor(async () => {
      const match = adapter.sent.find((msg) => msg.jobId === first.jobId && msg.status === "succeeded");
      return match ?? null;
    });

    expect(sentStatus.text).toContain("succeeded");

    await worker.stop();
    await dispatcher.stop();
  });
});
