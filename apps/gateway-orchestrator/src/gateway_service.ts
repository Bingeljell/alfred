import { InboundMessageSchema, JobCreateSchema } from "../../../packages/contracts/src";
import { FileBackedQueueStore } from "./local_queue_store";
import { OutboundNotificationStore } from "./notification_store";
import { MessageDedupeStore } from "./whatsapp/dedupe_store";
import { normalizeBaileysInbound } from "./whatsapp/normalize_baileys";

export class GatewayService {
  constructor(
    private readonly store: FileBackedQueueStore,
    private readonly notificationStore?: OutboundNotificationStore
  ) {}

  async health(): Promise<{
    service: "gateway-orchestrator";
    status: "ok";
    queue: Record<string, number>;
  }> {
    const queue = await this.store.statusCounts();
    return {
      service: "gateway-orchestrator",
      status: "ok",
      queue
    };
  }

  async handleInbound(payload: unknown): Promise<{
    accepted: boolean;
    mode: "chat" | "async-job";
    response?: string;
    jobId?: string;
  }> {
    const inbound = InboundMessageSchema.parse(payload ?? {});

    if (inbound.requestJob) {
      const job = await this.store.createJob({
        type: "stub_task",
        payload: {
          text: inbound.text,
          sessionId: inbound.sessionId,
          ...inbound.metadata
        },
        priority: 5
      });

      if (this.notificationStore) {
        await this.notificationStore.enqueue({
          sessionId: inbound.sessionId,
          jobId: job.id,
          status: "queued",
          text: `Job ${job.id} is queued`
        });
      }

      return {
        accepted: true,
        mode: "async-job",
        jobId: job.id
      };
    }

    return {
      accepted: true,
      mode: "chat",
      response: `ack:${inbound.text ?? ""}`
    };
  }

  async createJob(payload: unknown): Promise<{ jobId: string; status: string }> {
    const input = JobCreateSchema.parse(payload ?? {});
    const job = await this.store.createJob(input);

    const sessionId = typeof input.payload.sessionId === "string" ? input.payload.sessionId : undefined;
    if (sessionId && this.notificationStore) {
      await this.notificationStore.enqueue({
        sessionId,
        jobId: job.id,
        status: "queued",
        text: `Job ${job.id} is queued`
      });
    }

    return { jobId: job.id, status: job.status };
  }

  async getJob(jobId: string) {
    return this.store.getJob(jobId);
  }

  async cancelJob(jobId: string) {
    return this.store.cancelJob(jobId);
  }

  async handleBaileysInbound(payload: unknown, dedupeStore: MessageDedupeStore): Promise<{
    accepted: boolean;
    duplicate: boolean;
    mode?: "chat" | "async-job";
    response?: string;
    jobId?: string;
    providerMessageId?: string;
  }> {
    const normalized = normalizeBaileysInbound(payload);
    const duplicate = await dedupeStore.isDuplicateAndMark(normalized.dedupeKey);

    if (duplicate) {
      return {
        accepted: true,
        duplicate: true,
        providerMessageId: normalized.providerMessageId
      };
    }

    const result = await this.handleInbound(normalized.normalized);
    return {
      ...result,
      duplicate: false,
      providerMessageId: normalized.providerMessageId
    };
  }
}
