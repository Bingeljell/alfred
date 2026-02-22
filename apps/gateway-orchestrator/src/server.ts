import { loadConfig } from "./config";
import { createGatewayApp } from "./app";
import { FileBackedQueueStore } from "./local_queue_store";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  await store.ensureReady();

  const app = createGatewayApp(store);
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] listening on :${config.port} using state dir ${config.stateDir}`);
  });
}

void main();
