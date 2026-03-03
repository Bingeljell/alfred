import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "process.wait",
  capability: "shell_exec",
  safetyTier: "read_only",
  description: "Waits for local process readiness by PID/pattern/port."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "process.wait",
  toolId: "process.wait",
  executionPlane: "gateway",
  description: "Wait for process readiness via pid/pattern/port checks.",
  inputHints: ["pid", "pattern", "verifyPort", "timeoutSec", "cwd", "reason"]
};

export const inputSchema = z.object({
  pid: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  verifyPort: z.number().int().positive().max(65535).optional(),
  timeoutSec: z.number().int().positive().max(300).optional(),
  cwd: z.string().optional(),
  reason: z.string().optional()
});
