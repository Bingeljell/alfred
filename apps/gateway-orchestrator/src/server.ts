import { loadConfig } from "./config";
import { createGatewayApp } from "./app";
import { FileBackedQueueStore } from "./local_queue_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { OutboundNotificationStore } from "./notification_store";
import { startNotificationDispatcher } from "./notification_dispatcher";
import { StdoutWhatsAppAdapter } from "../../../packages/provider-adapters/src";
import { MemoryService } from "../../../packages/memory/src";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const dedupeStore = new MessageDedupeStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const memoryService = new MemoryService({
    rootDir: process.cwd(),
    stateDir: config.stateDir
  });

  await store.ensureReady();
  await dedupeStore.ensureReady();
  await notificationStore.ensureReady();
  await memoryService.start();

  const app = createGatewayApp(store, { dedupeStore, notificationStore, memoryService });
  const adapter = new StdoutWhatsAppAdapter();
  const dispatcher = startNotificationDispatcher({
    store: notificationStore,
    adapter,
    pollIntervalMs: config.notificationPollMs
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] listening on :${config.port} using state dir ${config.stateDir}`);
  });

  const shutdown = async () => {
    await dispatcher.stop();
    await memoryService.stop();
    server.close();
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
