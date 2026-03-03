import { z } from "zod";
import type { ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "file.edit",
  capability: "file_write",
  safetyTier: "side_effecting",
  description: "Edits existing files with optional hash guards."
};

export const inputSchema = z.object({
  targetPath: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  expectedHash: z.string().optional(),
  replaceAll: z.boolean().optional(),
  reason: z.string().optional()
});
