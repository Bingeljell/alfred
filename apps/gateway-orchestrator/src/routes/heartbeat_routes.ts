import type { Express } from "express";
import { z } from "zod";

const HeartbeatConfigureBodySchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(15000).max(24 * 60 * 60 * 1000).optional(),
  activeHoursStart: z.number().int().min(0).max(23).optional(),
  activeHoursEnd: z.number().int().min(0).max(23).optional(),
  requireIdleQueue: z.boolean().optional(),
  dedupeWindowMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
  suppressOk: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  pendingNotificationAlertThreshold: z.number().int().min(1).max(1000).optional(),
  recentErrorLookbackMinutes: z.number().int().min(1).max(24 * 60).optional(),
  alertOnAuthDisconnected: z.boolean().optional(),
  alertOnWhatsAppDisconnected: z.boolean().optional(),
  alertOnStuckJobs: z.boolean().optional(),
  stuckJobThresholdMinutes: z.number().int().min(1).max(24 * 60).optional()
});

const HeartbeatRunBodySchema = z.object({
  force: z.boolean().optional()
});

type HeartbeatServiceLike = {
  status: () => Promise<unknown> | unknown;
  configure: (patch: {
    enabled?: boolean;
    intervalMs?: number;
    activeHoursStart?: number;
    activeHoursEnd?: number;
    requireIdleQueue?: boolean;
    dedupeWindowMs?: number;
    suppressOk?: boolean;
    sessionId?: string;
    pendingNotificationAlertThreshold?: number;
    recentErrorLookbackMinutes?: number;
    alertOnAuthDisconnected?: boolean;
    alertOnWhatsAppDisconnected?: boolean;
    alertOnStuckJobs?: boolean;
    stuckJobThresholdMinutes?: number;
  }) => Promise<unknown>;
  runNow: (options?: { force?: boolean; trigger?: string }) => Promise<unknown>;
};

export function registerHeartbeatRoutes(app: Express, deps: { heartbeatService?: HeartbeatServiceLike }) {
  app.get("/v1/heartbeat/status", async (_req, res) => {
    if (!deps.heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    const status = await deps.heartbeatService.status();
    res.status(200).json(status);
  });

  app.post("/v1/heartbeat/configure", async (req, res) => {
    if (!deps.heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    try {
      const patch = HeartbeatConfigureBodySchema.parse(req.body ?? {});
      const status = await deps.heartbeatService.configure(patch);
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_heartbeat_config", detail: String(error) });
    }
  });

  app.post("/v1/heartbeat/run", async (req, res) => {
    if (!deps.heartbeatService) {
      res.status(404).json({ error: "heartbeat_not_configured" });
      return;
    }

    try {
      const input = HeartbeatRunBodySchema.parse(req.body ?? {});
      const status = await deps.heartbeatService.runNow({ force: input.force ?? true, trigger: "manual_api" });
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_heartbeat_run_request", detail: String(error) });
    }
  });
}
