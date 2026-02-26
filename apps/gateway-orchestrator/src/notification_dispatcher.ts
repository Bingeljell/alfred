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
          if (message.kind === "file") {
            if (adapter.sendFile) {
              await adapter.sendFile({
                sessionId: message.sessionId,
                filePath: String(message.filePath ?? ""),
                fileName: message.fileName,
                mimeType: message.mimeType,
                caption: message.caption
              });
            } else {
              const fallbackText =
                message.text ??
                message.caption ??
                `File delivery is not supported by adapter '${adapter.name}' for ${message.fileName ?? "attachment"}.`;
              await adapter.sendText({
                sessionId: message.sessionId,
                text: fallbackText,
                jobId: message.jobId,
                status: message.status
              });
            }
          } else {
            await adapter.sendText({
              sessionId: message.sessionId,
              text: String(message.text ?? ""),
              jobId: message.jobId,
              status: message.status
            });
          }
          await store.markDelivered(message.id);
          if (conversationStore) {
            try {
              const transcriptText =
                message.kind === "file"
                  ? `[attachment] ${message.fileName ?? "file"}${message.caption ? `\n${message.caption}` : ""}`
                  : String(message.text ?? "");
              await conversationStore.add(message.sessionId, "outbound", transcriptText, {
                source: "worker",
                channel: adapter.name === "baileys" ? "baileys" : "internal",
                kind: message.status ? "job" : "chat",
                metadata: {
                  notificationId: message.id,
                  jobId: message.jobId,
                  status: message.status ?? "unknown",
                  type: message.kind ?? "text"
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
                  details: String(message.text ?? message.caption ?? ""),
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
