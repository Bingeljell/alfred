import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "process.start",
  capability: "shell_exec",
  safetyTier: "privileged",
  description: "Starts a local process in the background with optional readiness checks."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "process.start",
  toolId: "process.start",
  executionPlane: "worker",
  description: "Start a background process with verification checks (approval-gated).",
  inputHints: ["command", "cwd", "verifyPattern", "verifyPort", "timeoutSec", "rerunQuery", "reason"]
};

export const inputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  verifyPattern: z.string().optional(),
  verifyPort: z.number().int().positive().max(65535).optional(),
  timeoutSec: z.number().int().positive().max(300).optional(),
  rerunQuery: z.string().optional(),
  reason: z.string().optional()
});
