import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "process.list",
  capability: "shell_exec",
  safetyTier: "read_only",
  description: "Lists running local processes with optional pattern filtering."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "process.list",
  toolId: "process.list",
  executionPlane: "gateway",
  description: "List running processes, optionally filtered by pattern.",
  inputHints: ["pattern", "limit", "cwd", "reason"]
};

export const inputSchema = z.object({
  pattern: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  cwd: z.string().optional(),
  reason: z.string().optional()
});
