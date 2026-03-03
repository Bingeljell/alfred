import { z } from "zod";
import type { AgentActionSpecV1, ToolSpecV1 } from "../_core/types";

export const toolSpec: ToolSpecV1 = {
  version: 1,
  toolId: "web.extract",
  capability: "web_search",
  safetyTier: "read_only",
  description: "Extracts structured evidence/summaries from fetched web pages."
};

export const actionSpec: AgentActionSpecV1 = {
  version: 1,
  type: "web.extract",
  toolId: "web.extract",
  executionPlane: "either",
  description: "Synthesize grounded findings from web evidence.",
  inputHints: ["query", "urls", "provider", "reason"]
};

export const inputSchema = z.object({
  query: z.string().optional(),
  urls: z.array(z.string().url()).max(8).optional(),
  provider: z.enum(["auto", "searxng", "openai", "brave", "perplexity", "brightdata"]).optional(),
  reason: z.string().optional()
});
