import { loadConfig, loadDotEnvFile } from "./config";
import { createGatewayApp } from "./app";
import { FileBackedQueueStore } from "./local_queue_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { OutboundNotificationStore } from "./notification_store";
import { startNotificationDispatcher } from "./notification_dispatcher";
import { StdoutWhatsAppAdapter } from "../../../packages/provider-adapters/src";
import { MemoryService } from "../../../packages/memory/src";
import { ReminderStore } from "./builtins/reminder_store";
import { NoteStore } from "./builtins/note_store";
import { TaskStore } from "./builtins/task_store";
import { ApprovalStore } from "./builtins/approval_store";
import { startReminderDispatcher } from "./builtins/reminder_dispatcher";
import { OAuthService } from "./auth/oauth_service";

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig();
  const store = new FileBackedQueueStore(config.stateDir);
  const dedupeStore = new MessageDedupeStore(config.stateDir);
  const notificationStore = new OutboundNotificationStore(config.stateDir);
  const reminderStore = new ReminderStore(config.stateDir);
  const noteStore = new NoteStore(config.stateDir);
  const taskStore = new TaskStore(config.stateDir);
  const approvalStore = new ApprovalStore(config.stateDir);
  const oauthService = new OAuthService({
    stateDir: config.stateDir,
    publicBaseUrl: config.publicBaseUrl,
    encryptionKey: config.oauthTokenEncryptionKey,
    stateTtlMs: config.oauthStateTtlMs,
    openai: {
      mode: config.oauthOpenAiMode,
      clientId: config.oauthOpenAiClientId,
      clientSecret: config.oauthOpenAiClientSecret,
      authorizeUrl: config.oauthOpenAiAuthorizeUrl,
      tokenUrl: config.oauthOpenAiTokenUrl,
      scope: config.oauthOpenAiScope
    }
  });
  const memoryService = new MemoryService({
    rootDir: process.cwd(),
    stateDir: config.stateDir
  });

  await store.ensureReady();
  await dedupeStore.ensureReady();
  await notificationStore.ensureReady();
  await reminderStore.ensureReady();
  await noteStore.ensureReady();
  await taskStore.ensureReady();
  await approvalStore.ensureReady();
  await oauthService.ensureReady();
  await memoryService.start();

  const app = createGatewayApp(store, {
    dedupeStore,
    notificationStore,
    memoryService,
    reminderStore,
    noteStore,
    taskStore,
    approvalStore,
    oauthService
  });
  const adapter = new StdoutWhatsAppAdapter();
  const dispatcher = startNotificationDispatcher({
    store: notificationStore,
    adapter,
    pollIntervalMs: config.notificationPollMs
  });
  const reminderDispatcher = startReminderDispatcher({
    reminderStore,
    notificationStore,
    pollIntervalMs: config.reminderPollMs
  });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] listening on :${config.port} using state dir ${config.stateDir}`);
  });

  const shutdown = async () => {
    await dispatcher.stop();
    await reminderDispatcher.stop();
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
