import { loadConfig, loadDotEnvFile } from "../../gateway-orchestrator/src/config";
import { FileBackedQueueStore } from "../../gateway-orchestrator/src/local_queue_store";
import { OutboundNotificationStore } from "../../gateway-orchestrator/src/notification_store";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);

  await store.ensureReady();
  await notificationStore.ensureReady();

  const handle = startWorker({
    store,
    pollIntervalMs: config.workerPollMs,
    workerId: "worker-main",
    onStatusChange: async (event) => {
      if (!event.sessionId) {
        return;
      }

      const summary = event.summary ? ` (${event.summary})` : "";
      await notificationStore.enqueue({
        sessionId: event.sessionId,
        jobId: event.jobId,
        status: event.status,
        text: `Job ${event.jobId} is ${event.status}${summary}`
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(`[worker] running with poll interval ${config.workerPollMs}ms`);

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
