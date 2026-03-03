import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "web.search",
  capability: "web_search",
  safetyTier: "read_only",
  description: "Fetches web search results from configured providers."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "web.search",
  toolId: "web.search",
  executionPlane: "either",
  description: "Run web retrieval for live/current information.",
  inputHints: ["query", "provider", "mode", "reason"]
};

export const inputSchema = z.object({
  query: z.string().min(1),
  provider: z.enum(["auto", "searxng", "openai", "brave", "perplexity", "brightdata"]).optional(),
  mode: z.enum(["quick", "deep"]).optional(),
  reason: z.string().optional()
});
