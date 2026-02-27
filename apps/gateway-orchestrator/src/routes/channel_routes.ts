import type { Express } from "express";
import { z } from "zod";
import { MessageDedupeStore } from "../whatsapp/dedupe_store";

const CancelParamsSchema = z.object({
  jobId: z.string().min(1)
});

const IdentityMappingBodySchema = z.object({
  whatsAppJid: z.string().min(1),
  authSessionId: z.string().min(1)
});

type GatewayServiceLike = {
  handleInbound: (payload: unknown) => Promise<{ mode?: string } & Record<string, unknown>>;
  handleBaileysInbound: (
    payload: unknown,
    dedupeStore: MessageDedupeStore
  ) => Promise<{ mode?: string; duplicate?: boolean } & Record<string, unknown>>;
  createJob: (payload: unknown) => Promise<unknown>;
  getJob: (jobId: string) => Promise<{ id: string; status: string } | null>;
  cancelJob: (jobId: string) => Promise<{ id: string; status: string } | null>;
  retryJob: (jobId: string) => Promise<{ id: string; status: string } | null>;
};

type IdentityProfileStoreLike = {
  listMappings: (limit?: number) => Promise<unknown>;
  getMapping: (whatsAppJid: string) => Promise<unknown | null>;
  setMapping: (whatsAppJid: string, authSessionId: string) => Promise<unknown>;
};

type WhatsAppLiveManagerLike = {
  status: () => unknown | Promise<unknown>;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
};

export function registerChannelRoutes(
  app: Express,
  deps: {
    service: GatewayServiceLike;
    dedupeStore: MessageDedupeStore;
    identityProfileStore?: IdentityProfileStoreLike;
    whatsAppLiveManager?: WhatsAppLiveManagerLike;
    baileysInboundToken?: string;
    withQrImageData: (status: unknown) => Promise<unknown>;
    isAuthorizedBaileysInbound: (expectedToken: string | undefined, providedHeader: unknown) => boolean;
  }
) {
  app.get("/v1/identity/mappings", async (_req, res) => {
    if (!deps.identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }

    const mappings = await deps.identityProfileStore.listMappings(500);
    res.status(200).json({ mappings });
  });

  app.get("/v1/identity/resolve", async (req, res) => {
    if (!deps.identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }
    const whatsAppJid = typeof req.query.whatsAppJid === "string" ? req.query.whatsAppJid.trim() : "";
    if (!whatsAppJid) {
      res.status(400).json({ error: "missing_whatsapp_jid" });
      return;
    }

    const mapping = await deps.identityProfileStore.getMapping(whatsAppJid);
    if (!mapping) {
      res.status(404).json({ error: "identity_mapping_not_found", whatsAppJid });
      return;
    }
    res.status(200).json(mapping);
  });

  app.post("/v1/identity/mappings", async (req, res) => {
    if (!deps.identityProfileStore) {
      res.status(404).json({ error: "identity_mapping_not_configured" });
      return;
    }

    try {
      const input = IdentityMappingBodySchema.parse(req.body ?? {});
      const saved = await deps.identityProfileStore.setMapping(input.whatsAppJid, input.authSessionId);
      res.status(200).json(saved);
    } catch (error) {
      res.status(400).json({ error: "invalid_identity_mapping", detail: String(error) });
    }
  });

  app.post("/v1/messages/inbound", async (req, res) => {
    try {
      const result = await deps.service.handleInbound(req.body);
      res.status(result.mode === "async-job" ? 202 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_inbound_message", detail: String(error) });
    }
  });

  app.post("/v1/whatsapp/baileys/inbound", async (req, res) => {
    if (!deps.isAuthorizedBaileysInbound(deps.baileysInboundToken, req.headers["x-baileys-inbound-token"])) {
      res.status(401).json({ error: "unauthorized_baileys_inbound" });
      return;
    }

    try {
      const result = await deps.service.handleBaileysInbound(req.body, deps.dedupeStore);
      if (result.duplicate) {
        res.status(200).json(result);
        return;
      }
      res.status(result.mode === "async-job" ? 202 : 200).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_baileys_inbound", detail: String(error) });
    }
  });

  app.get("/v1/whatsapp/live/status", async (_req, res) => {
    if (!deps.whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    const status = await deps.whatsAppLiveManager.status();
    const withQrImage = await deps.withQrImageData(status);
    res.status(200).json(withQrImage);
  });

  app.post("/v1/whatsapp/live/connect", async (_req, res) => {
    if (!deps.whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    try {
      const status = await deps.whatsAppLiveManager.connect();
      const withQrImage = await deps.withQrImageData(status);
      res.status(200).json(withQrImage);
    } catch (error) {
      res.status(400).json({ error: "whatsapp_live_connect_failed", detail: String(error) });
    }
  });

  app.post("/v1/whatsapp/live/disconnect", async (_req, res) => {
    if (!deps.whatsAppLiveManager) {
      res.status(404).json({ error: "whatsapp_live_not_configured" });
      return;
    }

    try {
      const status = await deps.whatsAppLiveManager.disconnect();
      const withQrImage = await deps.withQrImageData(status);
      res.status(200).json(withQrImage);
    } catch (error) {
      res.status(400).json({ error: "whatsapp_live_disconnect_failed", detail: String(error) });
    }
  });

  app.post("/v1/jobs", async (req, res) => {
    try {
      const result = await deps.service.createJob(req.body);
      res.status(202).json(result);
    } catch (error) {
      res.status(400).json({ error: "invalid_job_request", detail: String(error) });
    }
  });

  app.get("/v1/jobs/:jobId", async (req, res) => {
    const job = await deps.service.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }

    res.status(200).json(job);
  });

  app.post("/v1/jobs/:jobId/cancel", async (req, res) => {
    try {
      const params = CancelParamsSchema.parse(req.params);
      const job = await deps.service.cancelJob(params.jobId);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      res.status(200).json({ jobId: job.id, status: job.status });
    } catch (error) {
      res.status(400).json({ error: "invalid_cancel_request", detail: String(error) });
    }
  });

  app.post("/v1/jobs/:jobId/retry", async (req, res) => {
    try {
      const params = CancelParamsSchema.parse(req.params);
      const job = await deps.service.retryJob(params.jobId);
      if (!job) {
        res.status(409).json({ error: "job_retry_unavailable" });
        return;
      }
      res.status(202).json({ jobId: job.id, status: job.status, retryOf: params.jobId });
    } catch (error) {
      res.status(400).json({ error: "invalid_retry_request", detail: String(error) });
    }
  });
}
