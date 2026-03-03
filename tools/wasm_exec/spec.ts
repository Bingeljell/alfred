import { z } from "zod";
import type { ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "wasm.exec",
  capability: "wasm_exec",
  safetyTier: "privileged",
  description: "Reserved runtime surface for sandboxed WASM guest execution."
};

export const inputSchema = z.object({
  module: z.string().optional(),
  entry: z.string().optional(),
  args: z.array(z.string()).optional(),
  reason: z.string().optional()
});
