import { z } from "zod";
import type { ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "file.send",
  capability: "file_write",
  safetyTier: "side_effecting",
  description: "Sends workspace files as outbound channel attachments."
};

export const inputSchema = z.object({
  targetPath: z.string().min(1),
  caption: z.string().optional(),
  reason: z.string().optional()
});
