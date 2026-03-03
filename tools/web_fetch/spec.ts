import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "web.fetch",
  capability: "web_search",
  safetyTier: "read_only",
  description: "Fetches and normalizes web page content from a URL."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "web.fetch",
  toolId: "web.fetch",
  executionPlane: "gateway",
  description: "Fetch and summarize a specific URL.",
  inputHints: ["url", "reason"]
};

export const inputSchema = z.object({
  url: z.string().url(),
  reason: z.string().optional()
});
