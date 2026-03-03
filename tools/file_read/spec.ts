import { z } from "zod";
import type { ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "file.read",
  capability: "file_read",
  safetyTier: "read_only",
  description: "Reads file content within configured allowlisted roots."
};

export const inputSchema = z.object({
  targetPath: z.string().min(1),
  reason: z.string().optional()
});
