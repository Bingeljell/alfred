import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "process.kill",
  capability: "shell_exec",
  safetyTier: "privileged",
  description: "Stops local processes by PID or pattern with post-kill verification."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "process.kill",
  toolId: "process.kill",
  executionPlane: "worker",
  description: "Terminate process(es) by PID or pattern (approval-gated).",
  inputHints: ["pid", "pattern", "signal", "cwd", "rerunQuery", "reason"]
};

export const inputSchema = z.object({
  pid: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  signal: z.enum(["TERM", "KILL", "INT"]).optional(),
  cwd: z.string().optional(),
  rerunQuery: z.string().optional(),
  reason: z.string().optional()
});
