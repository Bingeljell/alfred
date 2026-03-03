import { z } from "zod";
import type { ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "file.write",
  capability: "file_write",
  safetyTier: "side_effecting",
  description: "Writes text to workspace files within policy bounds."
};

export const inputSchema = z.object({
  targetPath: z.string().min(1),
  content: z.string(),
  mode: z.enum(["append", "replace"]).optional(),
  reason: z.string().optional()
});
