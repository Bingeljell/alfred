import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "shell.exec",
  capability: "shell_exec",
  safetyTier: "privileged",
  description: "Executes shell commands inside the workspace policy boundary."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "shell.exec",
  toolId: "shell.exec",
  executionPlane: "worker",
  description: "Execute a local shell command (approval-gated).",
  inputHints: ["command", "cwd", "rerunQuery", "reason"]
};

export const inputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  rerunQuery: z.string().optional(),
  reason: z.string().optional()
});
