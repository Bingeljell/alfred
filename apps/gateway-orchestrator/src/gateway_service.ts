import { InboundMessageSchema, JobCreateSchema } from "../../../packages/contracts/src";
import { FileBackedQueueStore } from "./local_queue_store";

export class GatewayService {
  constructor(private readonly store: FileBackedQueueStore) {}

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
    return { jobId: job.id, status: job.status };
  }

  async getJob(jobId: string) {
    return this.store.getJob(jobId);
  }

  async cancelJob(jobId: string) {
    return this.store.cancelJob(jobId);
  }
}
