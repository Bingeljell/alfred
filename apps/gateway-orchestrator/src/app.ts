import express from "express";
import { z } from "zod";
import { FileBackedQueueStore } from "./local_queue_store";
import { GatewayService } from "./gateway_service";

const CancelParamsSchema = z.object({
  jobId: z.string().min(1)
});

export function createGatewayApp(store: FileBackedQueueStore) {
  const app = express();
  const service = new GatewayService(store);
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const health = await service.health();
    res.status(200).json(health);
  });

  app.post("/v1/messages/inbound", async (req, res) => {
    try {
      const result = await service.handleInbound(req.body);
      res.status(result.mode === "async-job" ? 202 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_inbound_message", detail: String(error) });
    }
  });

  app.post("/v1/jobs", async (req, res) => {
    try {
      const result = await service.createJob(req.body);
      res.status(202).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_job_request", detail: String(error) });
    }
  });

  app.get("/v1/jobs/:jobId", async (req, res) => {
    const job = await service.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }

    res.status(200).json(job);
  });

  app.post("/v1/jobs/:jobId/cancel", async (req, res) => {
    try {
      const params = CancelParamsSchema.parse(req.params);
      const job = await service.cancelJob(params.jobId);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      res.status(200).json({ jobId: job.id, status: job.status });
    } catch (error) {
      res.status(400).json({ error: "invalid_cancel_request", detail: String(error) });
    }
  });

  return app;
}
