import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "file.read.range",
  capability: "file_read",
  safetyTier: "read_only",
  description: "Reads bounded line ranges from files within allowlisted roots."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "file.read.range",
  toolId: "file.read.range",
  executionPlane: "gateway",
  description: "Read bounded file lines within allowlisted roots.",
  inputHints: ["targetPath", "fromLine", "lineCount", "reason"]
};

export const inputSchema = z.object({
  targetPath: z.string().min(1),
  fromLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(400).optional(),
  reason: z.string().optional()
});
