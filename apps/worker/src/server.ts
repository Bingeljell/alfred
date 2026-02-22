import { loadConfig } from "../../gateway-orchestrator/src/config";
import { FileBackedQueueStore } from "../../gateway-orchestrator/src/local_queue_store";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  await store.ensureReady();

  const handle = startWorker({
    store,
    pollIntervalMs: config.workerPollMs,
    workerId: "worker-main"
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
