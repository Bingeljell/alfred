import type { Express } from "express";
import { z } from "zod";

const DEFAULT_STREAM_KINDS = ["chat", "command", "job", "error"] as const;
const ConversationSourceValues = ["gateway", "whatsapp", "auth", "memory", "worker", "system"] as const;
const ConversationChannelValues = ["direct", "baileys", "api", "internal"] as const;
const ConversationKindValues = ["chat", "command", "job", "status", "error", "dedupe"] as const;
const ConversationDirectionValues = ["inbound", "outbound", "system"] as const;

const ApprovalResolveBodySchema = z.object({
  sessionId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  token: z.string().min(1).optional(),
  authSessionId: z.string().min(1).optional(),
  authPreference: z.enum(["auto", "oauth", "api_key"]).optional()
});

const ExecutionPolicyPreviewBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  authSessionId: z.string().min(1).optional(),
  authPreference: z.enum(["auto", "oauth", "api_key"]).optional()
});

type ConversationEvent = {
  sessionId: string;
  source: (typeof ConversationSourceValues)[number];
  channel: (typeof ConversationChannelValues)[number];
  direction: (typeof ConversationDirectionValues)[number];
  kind: (typeof ConversationKindValues)[number];
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type ConversationStoreLike = {
  query: (input: {
    sessionId?: string;
    limit?: number;
    kinds?: (typeof ConversationKindValues)[number][];
    sources?: (typeof ConversationSourceValues)[number][];
    channels?: (typeof ConversationChannelValues)[number][];
    directions?: (typeof ConversationDirectionValues)[number][];
    text?: string;
    since?: string;
    until?: string;
  }) => Promise<ConversationEvent[]>;
  subscribe: (handler: (event: ConversationEvent) => void) => () => void;
  listSessions?: (limit?: number) => Promise<
    Array<{
      sessionId: string;
      lastAt: string;
      lastDirection: string;
      lastKind: string;
      lastSource: string;
      preview: string;
      eventCount: number;
    }>
  >;
};

type RunLedgerLike = {
  listRuns: (input: { sessionKey?: string; limit?: number }) => Promise<unknown[]>;
  getRun: (runId: string) => Promise<unknown | null>;
};

type RunSpecStoreLike = {
  get: (runId: string) => Promise<unknown | null>;
};

type SupervisorStoreLike = {
  list: (input: { sessionId?: string; limit?: number }) => Promise<unknown[]>;
  get: (id: string) => Promise<unknown | null>;
};

type ApprovalServiceLike = {
  listPendingApprovals: (sessionId: string, limit?: number) => Promise<unknown[]>;
  handleInbound: (input: {
    sessionId: string;
    text: string;
    requestJob?: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
};

type ExecutionPolicyServiceLike = {
  previewExecutionPolicy: (input: {
    sessionId: string;
    text: string;
    authSessionId?: string;
    authPreference?: "auto" | "oauth" | "api_key";
  }) => Promise<unknown>;
};

type ToolManifestServiceLike = {
  manifest: (input?: { sessionId?: string; authSessionId?: string }) => unknown[];
  compact: (input?: { sessionId?: string; authSessionId?: string }) => unknown[];
};

function parseCsvFilter<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const allowedSet = new Set<string>(allowed);
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && allowedSet.has(item)) as T[];
  return values.length > 0 ? values : undefined;
}

function clampLimit(raw: unknown, defaults: { fallback: number; min: number; max: number }) {
  const parsed = Number(raw ?? defaults.fallback);
  if (!Number.isFinite(parsed)) {
    return defaults.fallback;
  }
  return Math.max(defaults.min, Math.min(defaults.max, Math.floor(parsed)));
}

function getEventMetadata(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {};
  }
  const maybe = (event as { metadata?: unknown }).metadata;
  if (!maybe || typeof maybe !== "object" || Array.isArray(maybe)) {
    return {};
  }
  return maybe as Record<string, unknown>;
}

function extractRunSpecArtifacts(runSpec: unknown): Array<{
  type: "file";
  path: string;
  name: string;
  mimeType?: string;
}> {
  if (!runSpec || typeof runSpec !== "object") {
    return [];
  }
  const value = runSpec as Record<string, unknown>;
  const stepStates = value.stepStates;
  if (!stepStates || typeof stepStates !== "object" || Array.isArray(stepStates)) {
    return [];
  }
  const rows: Array<{ type: "file"; path: string; name: string; mimeType?: string }> = [];
  for (const item of Object.values(stepStates as Record<string, unknown>)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const output = (item as Record<string, unknown>).output;
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      continue;
    }
    const outputRecord = output as Record<string, unknown>;
    const filePath = typeof outputRecord.filePath === "string" ? outputRecord.filePath.trim() : "";
    if (!filePath) {
      continue;
    }
    const fileName = typeof outputRecord.fileName === "string" && outputRecord.fileName.trim() ? outputRecord.fileName.trim() : filePath;
    const mimeType = typeof outputRecord.mimeType === "string" && outputRecord.mimeType.trim() ? outputRecord.mimeType.trim() : undefined;
    rows.push({
      type: "file",
      path: filePath,
      name: fileName,
      mimeType
    });
  }
  const seen = new Set<string>();
  return rows.filter((item) => {
    const key = `${item.path}:${item.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function registerObservabilityRoutes(
  app: Express,
  deps: {
    conversationStore?: ConversationStoreLike;
    runLedger?: RunLedgerLike;
    runSpecStore?: RunSpecStoreLike;
    supervisorStore?: SupervisorStoreLike;
    approvalService: ApprovalServiceLike;
    executionPolicyService?: ExecutionPolicyServiceLike;
    toolManifestService?: ToolManifestServiceLike;
  }
) {
  app.get("/v1/agent/sessions", async (req, res) => {
    if (!deps.conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }
    const limit = clampLimit(req.query.limit, { fallback: 100, min: 1, max: 500 });
    if (deps.conversationStore.listSessions) {
      const sessions = await deps.conversationStore.listSessions(limit);
      res.status(200).json({ sessions });
      return;
    }
    const events = await deps.conversationStore.query({
      limit: Math.min(500, Math.max(100, limit * 10))
    });
    const bySession = new Map<string, ConversationEvent>();
    for (const event of events) {
      const previous = bySession.get(event.sessionId);
      if (!previous || Date.parse(event.createdAt) >= Date.parse(previous.createdAt)) {
        bySession.set(event.sessionId, event);
      }
    }
    const sessions = Array.from(bySession.values())
      .map((event) => ({
        sessionId: event.sessionId,
        lastAt: event.createdAt,
        lastDirection: event.direction,
        lastKind: event.kind,
        lastSource: event.source,
        preview: event.text.slice(0, 160)
      }))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
      .slice(0, limit);
    res.status(200).json({ sessions });
  });

  app.get("/v1/agent/runs", async (req, res) => {
    if (!deps.runLedger) {
      res.status(404).json({ error: "run_ledger_not_configured" });
      return;
    }
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const limit = clampLimit(req.query.limit, { fallback: 100, min: 1, max: 500 });
    let runs = await deps.runLedger.listRuns({
      sessionKey: sessionId || undefined,
      limit
    });
    if (runs.length === 0 && sessionId && deps.conversationStore) {
      const observed = await deps.conversationStore.query({
        sessionId,
        limit: Math.max(200, limit * 4)
      });
      const authSessionIds = Array.from(
        new Set(
          observed
            .map((event) => {
              const metadata = getEventMetadata(event);
              return typeof metadata.authSessionId === "string" ? metadata.authSessionId.trim() : "";
            })
            .filter((value) => value.length > 0)
        )
      );
      if (authSessionIds.length > 0) {
        const merged = await Promise.all(
          authSessionIds.map((authSessionId) =>
            deps.runLedger!.listRuns({
              sessionKey: authSessionId,
              limit
            })
          )
        );
        const deduped = new Map<string, unknown>();
        for (const row of merged.flat()) {
          const runId = typeof (row as { runId?: unknown }).runId === "string" ? (row as { runId: string }).runId : "";
          if (runId && !deduped.has(runId)) {
            deduped.set(runId, row);
          }
        }
        runs = Array.from(deduped.values())
          .sort((a, b) => {
            const aAt = Date.parse(String((a as { createdAt?: unknown }).createdAt ?? ""));
            const bAt = Date.parse(String((b as { createdAt?: unknown }).createdAt ?? ""));
            return (Number.isFinite(bAt) ? bAt : 0) - (Number.isFinite(aAt) ? aAt : 0);
          })
          .slice(0, limit);
      }
    }
    res.status(200).json({ runs });
  });

  app.get("/v1/agent/runs/:runId/events", async (req, res) => {
    if (!deps.conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }
    const runId = String(req.params.runId ?? "").trim();
    if (!runId) {
      res.status(400).json({ error: "runId_required" });
      return;
    }
    const limit = clampLimit(req.query.limit, { fallback: 200, min: 1, max: 1000 });
    const events = await deps.conversationStore.query({
      limit: Math.max(500, limit)
    });
    const filtered = events
      .filter((event) => {
        const metadata =
          event && typeof event === "object" && "metadata" in event
            ? ((event as unknown as { metadata?: Record<string, unknown> }).metadata ?? {})
            : {};
        const eventRunId = typeof metadata.runId === "string" ? metadata.runId : "";
        const eventJobId = typeof metadata.jobId === "string" ? metadata.jobId : "";
        return eventRunId === runId || eventJobId === runId;
      })
      .slice(-limit);
    res.status(200).json({ runId, events: filtered });
  });

  app.get("/v1/agent/runs/:runId/artifacts", async (req, res) => {
    if (!deps.runSpecStore) {
      res.status(200).json({ runId: req.params.runId, artifacts: [] });
      return;
    }
    const runId = String(req.params.runId ?? "").trim();
    if (!runId) {
      res.status(400).json({ error: "runId_required" });
      return;
    }
    const runSpec = await deps.runSpecStore.get(runId);
    const artifacts = extractRunSpecArtifacts(runSpec);
    res.status(200).json({ runId, artifacts });
  });

  app.get("/v1/stream/events", async (req, res) => {
    if (!deps.conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }

    const limit = clampLimit(req.query.limit, { fallback: 100, min: 1, max: 500 });
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const noisy =
      typeof req.query.noisy === "string" &&
      (req.query.noisy.toLowerCase() === "true" || req.query.noisy === "1");
    const kinds = parseCsvFilter(req.query.kinds, ConversationKindValues) ?? (noisy ? undefined : [...DEFAULT_STREAM_KINDS]);
    const sources = parseCsvFilter(req.query.sources, ConversationSourceValues);
    const channels = parseCsvFilter(req.query.channels, ConversationChannelValues);
    const directions = parseCsvFilter(req.query.directions, ConversationDirectionValues);
    const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
    const since = typeof req.query.since === "string" ? req.query.since.trim() : "";
    const until = typeof req.query.until === "string" ? req.query.until.trim() : "";

    const events = await deps.conversationStore.query({
      sessionId: sessionId || undefined,
      limit,
      kinds,
      sources,
      channels,
      directions,
      text: text || undefined,
      since: since || undefined,
      until: until || undefined
    });
    if (events.length > 0 || !sessionId) {
      res.status(200).json({ events });
      return;
    }
    const fallback = await deps.conversationStore.query({
      limit: Math.max(500, limit * 3),
      kinds,
      sources,
      channels,
      directions,
      text: text || undefined,
      since: since || undefined,
      until: until || undefined
    });
    const byAuthSession = fallback.filter((event) => {
      const metadata = getEventMetadata(event);
      return metadata.authSessionId === sessionId;
    });
    res.status(200).json({ events: byAuthSession.slice(-limit) });
  });

  app.get("/v1/tools/manifest", async (req, res) => {
    if (!deps.toolManifestService) {
      res.status(404).json({ error: "tool_manifest_not_configured" });
      return;
    }
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const authSessionId = typeof req.query.authSessionId === "string" ? req.query.authSessionId.trim() : "";
    const manifest = deps.toolManifestService.manifest({
      sessionId: sessionId || undefined,
      authSessionId: authSessionId || undefined
    });
    res.status(200).json({ tools: manifest });
  });

  app.get("/v1/tools/manifest/compact", async (req, res) => {
    if (!deps.toolManifestService) {
      res.status(404).json({ error: "tool_manifest_not_configured" });
      return;
    }
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const authSessionId = typeof req.query.authSessionId === "string" ? req.query.authSessionId.trim() : "";
    const manifest = deps.toolManifestService.compact({
      sessionId: sessionId || undefined,
      authSessionId: authSessionId || undefined
    });
    res.status(200).json({ tools: manifest });
  });

  app.get("/v1/runs", async (req, res) => {
    if (!deps.runLedger) {
      res.status(404).json({ error: "run_ledger_not_configured" });
      return;
    }

    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey.trim() : "";
    const limit = clampLimit(req.query.limit, { fallback: 50, min: 1, max: 500 });
    const runs = await deps.runLedger.listRuns({
      sessionKey: sessionKey || undefined,
      limit
    });
    res.status(200).json({ runs });
  });

  app.get("/v1/runs/:runId", async (req, res) => {
    if (!deps.runLedger) {
      res.status(404).json({ error: "run_ledger_not_configured" });
      return;
    }

    const run = await deps.runLedger.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    const runSpec = deps.runSpecStore ? await deps.runSpecStore.get(req.params.runId) : null;
    res.status(200).json({
      ...run,
      runSpec
    });
  });

  app.get("/v1/supervisors", async (req, res) => {
    if (!deps.supervisorStore) {
      res.status(404).json({ error: "supervisor_not_configured" });
      return;
    }

    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const limit = clampLimit(req.query.limit, { fallback: 50, min: 1, max: 200 });
    const runs = await deps.supervisorStore.list({
      sessionId: sessionId || undefined,
      limit
    });
    res.status(200).json({ runs });
  });

  app.get("/v1/supervisors/:id", async (req, res) => {
    if (!deps.supervisorStore) {
      res.status(404).json({ error: "supervisor_not_configured" });
      return;
    }
    const run = await deps.supervisorStore.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: "supervisor_not_found" });
      return;
    }
    res.status(200).json(run);
  });

  app.get("/v1/approvals/pending", async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "sessionId_required" });
      return;
    }

    const limit = clampLimit(req.query.limit, { fallback: 10, min: 1, max: 100 });
    const pending = await deps.approvalService.listPendingApprovals(sessionId, limit);
    res.status(200).json({
      sessionId,
      count: pending.length,
      pending
    });
  });

  app.post("/v1/approvals/resolve", async (req, res) => {
    const parsed = ApprovalResolveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_approval_resolve_request", detail: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const text =
      payload.decision === "approve"
        ? payload.token
          ? `approve ${payload.token}`
          : "yes"
        : payload.token
          ? `reject ${payload.token}`
          : "no";

    const result = await deps.approvalService.handleInbound({
      sessionId: payload.sessionId,
      text,
      requestJob: false,
      metadata: {
        ...(payload.authSessionId ? { authSessionId: payload.authSessionId } : {}),
        ...(payload.authPreference ? { authPreference: payload.authPreference } : {})
      }
    });
    res.status(200).json(result);
  });

  app.post("/v1/debug/execution-policy", async (req, res) => {
    if (!deps.executionPolicyService) {
      res.status(404).json({ error: "execution_policy_debug_not_configured" });
      return;
    }
    const parsed = ExecutionPolicyPreviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_execution_policy_preview_request", detail: parsed.error.flatten() });
      return;
    }
    const preview = await deps.executionPolicyService.previewExecutionPolicy(parsed.data);
    res.status(200).json(preview);
  });

  app.get("/v1/stream/events/subscribe", async (req, res) => {
    if (!deps.conversationStore) {
      res.status(404).json({ error: "stream_not_configured" });
      return;
    }

    const limit = clampLimit(req.query.limit, { fallback: 40, min: 1, max: 200 });
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const noisy =
      typeof req.query.noisy === "string" &&
      (req.query.noisy.toLowerCase() === "true" || req.query.noisy === "1");
    const kinds = parseCsvFilter(req.query.kinds, ConversationKindValues) ?? (noisy ? undefined : [...DEFAULT_STREAM_KINDS]);
    const sources = parseCsvFilter(req.query.sources, ConversationSourceValues);
    const channels = parseCsvFilter(req.query.channels, ConversationChannelValues);
    const directions = parseCsvFilter(req.query.directions, ConversationDirectionValues);
    const text = typeof req.query.text === "string" ? req.query.text.trim().toLowerCase() : "";
    const since = typeof req.query.since === "string" ? req.query.since.trim() : "";
    const until = typeof req.query.until === "string" ? req.query.until.trim() : "";
    const sourceSet = sources ? new Set(sources) : null;
    const channelSet = channels ? new Set(channels) : null;
    const kindSet = kinds ? new Set(kinds) : null;
    const directionSet = directions ? new Set(directions) : null;
    const sinceUnixMs = since ? Date.parse(since) : Number.NaN;
    const sinceEnabled = Number.isFinite(sinceUnixMs);
    const untilUnixMs = until ? Date.parse(until) : Number.NaN;
    const untilEnabled = Number.isFinite(untilUnixMs);

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");

    const initialEvents = await deps.conversationStore.query({
      sessionId: sessionId || undefined,
      limit,
      kinds,
      sources,
      channels,
      directions,
      text: text || undefined,
      since: since || undefined,
      until: until || undefined
    });
    for (const event of initialEvents) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = deps.conversationStore.subscribe((event) => {
      if (sessionId && event.sessionId !== sessionId) {
        return;
      }
      if (sourceSet && !sourceSet.has(event.source)) {
        return;
      }
      if (channelSet && !channelSet.has(event.channel)) {
        return;
      }
      if (kindSet && !kindSet.has(event.kind)) {
        return;
      }
      if (directionSet && !directionSet.has(event.direction)) {
        return;
      }
      if (text && !event.text.toLowerCase().includes(text)) {
        return;
      }
      if (sinceEnabled) {
        const eventUnixMs = Date.parse(event.createdAt);
        if (Number.isFinite(eventUnixMs) && eventUnixMs < sinceUnixMs) {
          return;
        }
      }
      if (untilEnabled) {
        const eventUnixMs = Date.parse(event.createdAt);
        if (Number.isFinite(eventUnixMs) && eventUnixMs >= untilUnixMs) {
          return;
        }
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const keepalive = setInterval(() => {
      res.write(":keepalive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    });
  });
}
