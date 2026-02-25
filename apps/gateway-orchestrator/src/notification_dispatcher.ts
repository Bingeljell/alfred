import type { WhatsAppAdapter } from "../../../packages/provider-adapters/src";
import { OutboundNotificationStore } from "./notification_store";
import { ConversationStore } from "./builtins/conversation_store";
import type { MemoryCheckpointClass } from "./builtins/memory_checkpoint_service";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type NotificationDispatcherHandle = {
  stop: () => Promise<void>;
};

export function startNotificationDispatcher(options: {
  store: OutboundNotificationStore;
  adapter: WhatsAppAdapter;
  conversationStore?: ConversationStore;
  memoryCheckpointService?: {
    checkpoint: (input: {
      sessionId: string;
      class: MemoryCheckpointClass;
      source: string;
      summary: string;
      details?: string;
      dedupeKey?: string;
      day?: string;
    }) => Promise<unknown>;
  };
  pollIntervalMs?: number;
}): NotificationDispatcherHandle {
  const store = options.store;
  const adapter = options.adapter;
  const conversationStore = options.conversationStore;
  const memoryCheckpointService = options.memoryCheckpointService;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  let active = true;

  const loop = async () => {
    while (active) {
      const pending = await store.listPending();
      if (pending.length === 0) {
        await sleep(pollIntervalMs);
        continue;
      }

      for (const message of pending) {
        try {
          await adapter.sendText({
            sessionId: message.sessionId,
            text: message.text,
            jobId: message.jobId,
            status: message.status
          });
          await store.markDelivered(message.id);
          if (conversationStore) {
            try {
              await conversationStore.add(message.sessionId, "outbound", message.text, {
                source: "worker",
                channel: adapter.name === "baileys" ? "baileys" : "internal",
                kind: message.status ? "job" : "chat",
                metadata: {
                  notificationId: message.id,
                  jobId: message.jobId,
                  status: message.status ?? "unknown"
                }
              });
            } catch {
              // best-effort observability
            }
          }
          if (memoryCheckpointService) {
            const status = String(message.status ?? "").trim().toLowerCase();
            if (status === "succeeded" || status === "failed" || status === "cancelled") {
              try {
                await memoryCheckpointService.checkpoint({
                  sessionId: message.sessionId,
                  class: status === "succeeded" ? "fact" : "todo",
                  source: "worker_notification",
                  summary: `Job ${message.jobId ?? "unknown"} ${status}`,
                  details: message.text,
                  dedupeKey: `worker_notification:${message.jobId ?? message.id}:${status}`
                });
              } catch {
                // best-effort checkpointing
              }
            }
          }
        } catch {
          // Keep pending for next retry loop.
        }
      }
    }
  };

  void loop();

  return {
    stop: async () => {
      active = false;
      await sleep(pollIntervalMs + 10);
    }
  };
}
