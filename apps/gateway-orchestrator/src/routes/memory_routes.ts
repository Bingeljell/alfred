import type { Express } from "express";
import { z } from "zod";

const MemoryCompactionRunBodySchema = z.object({
  force: z.boolean().optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

type MemoryServiceLike = {
  memoryStatus: () => unknown;
  syncMemory: (reason?: string) => Promise<void>;
  searchMemory: (query: string, options?: { maxResults?: number; minScore?: number }) => Promise<unknown>;
  getMemorySnippet: (filePath: string, from?: number, lines?: number) => Promise<string>;
  appendMemoryNote: (text: string, date?: string) => Promise<unknown>;
};

type MemoryCompactionServiceLike = {
  status: () => Promise<unknown> | unknown;
  runNow: (options?: { force?: boolean; trigger?: string; targetDate?: string }) => Promise<unknown>;
};

type MemoryCheckpointServiceLike = {
  status: () => Promise<unknown> | unknown;
};

export function registerMemoryRoutes(
  app: Express,
  deps: {
    memoryService?: MemoryServiceLike;
    memoryCompactionService?: MemoryCompactionServiceLike;
    memoryCheckpointService?: MemoryCheckpointServiceLike;
  }
) {
  app.get("/v1/memory/status", (_req, res) => {
    if (!deps.memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    res.status(200).json(deps.memoryService.memoryStatus());
  });

  app.post("/v1/memory/sync", async (_req, res) => {
    if (!deps.memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    await deps.memoryService.syncMemory("manual_api");
    res.status(200).json({ synced: true, status: deps.memoryService.memoryStatus() });
  });

  app.get("/v1/memory/compaction/status", async (_req, res) => {
    if (!deps.memoryCompactionService) {
      res.status(404).json({ error: "memory_compaction_not_configured" });
      return;
    }

    const status = await deps.memoryCompactionService.status();
    res.status(200).json(status);
  });

  app.post("/v1/memory/compaction/run", async (req, res) => {
    if (!deps.memoryCompactionService) {
      res.status(404).json({ error: "memory_compaction_not_configured" });
      return;
    }

    try {
      const input = MemoryCompactionRunBodySchema.parse(req.body ?? {});
      const status = await deps.memoryCompactionService.runNow({
        force: input.force ?? true,
        targetDate: input.targetDate,
        trigger: "manual_api"
      });
      res.status(200).json(status);
    } catch (error) {
      res.status(400).json({ error: "invalid_memory_compaction_run_request", detail: String(error) });
    }
  });

  app.get("/v1/memory/checkpoints/status", async (_req, res) => {
    if (!deps.memoryCheckpointService) {
      res.status(404).json({ error: "memory_checkpoints_not_configured" });
      return;
    }

    const status = await deps.memoryCheckpointService.status();
    res.status(200).json(status);
  });

  app.get("/v1/memory/search", async (req, res) => {
    if (!deps.memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    const query = typeof req.query.q === "string" ? req.query.q : "";
    const maxResults = typeof req.query.maxResults === "string" ? Number(req.query.maxResults) : undefined;
    const minScore = typeof req.query.minScore === "string" ? Number(req.query.minScore) : undefined;

    const results = await deps.memoryService.searchMemory(query, { maxResults, minScore });
    res.status(200).json({ results });
  });

  app.get("/v1/memory/snippet", async (req, res) => {
    if (!deps.memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const from = typeof req.query.from === "string" ? Number(req.query.from) : undefined;
    const lines = typeof req.query.lines === "string" ? Number(req.query.lines) : undefined;

    try {
      const snippet = await deps.memoryService.getMemorySnippet(filePath, from, lines);
      res.status(200).json({ snippet });
    } catch (error) {
      res.status(400).json({ error: "invalid_snippet_request", detail: String(error) });
    }
  });

  app.post("/v1/memory/notes", async (req, res) => {
    if (!deps.memoryService) {
      res.status(404).json({ error: "memory_not_configured" });
      return;
    }

    if (!req.body || typeof req.body.text !== "string" || req.body.text.trim().length === 0) {
      res.status(400).json({ error: "invalid_note_payload" });
      return;
    }

    const date = typeof req.body.date === "string" ? req.body.date : undefined;
    const written = await deps.memoryService.appendMemoryNote(req.body.text, date);
    res.status(201).json(written);
  });
}
