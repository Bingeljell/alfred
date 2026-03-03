import { z } from "zod";
import { AGENT_ACTION_SPECS_V1, TOOL_INPUT_SCHEMAS_V1, TOOL_SPECS_V1 } from "./registry";
import type { AgentActionSpecV1, ToolId, ToolPolicyDecision } from "./types";

export type RuntimeToolManifestEntry = {
  actionType: AgentActionSpecV1["type"];
  toolId?: ToolId;
  description: string;
  executionPlane?: AgentActionSpecV1["executionPlane"];
  longRunning?: boolean;
  inputHints?: string[];
  allowed: boolean;
  requiresApproval?: boolean;
  safetyTier?: "read_only" | "side_effecting" | "privileged";
  capability?: "web_search" | "file_read" | "file_write" | "shell_exec" | "wasm_exec";
  reason?: string;
  inputJsonSchema?: unknown;
};

export function buildRuntimeToolManifest(input: {
  evaluateToolPolicy: (toolId: ToolId) => ToolPolicyDecision;
  includeToolId?: (toolId: ToolId) => boolean;
}): RuntimeToolManifestEntry[] {
  const includeToolId = input.includeToolId ?? (() => true);
  return AGENT_ACTION_SPECS_V1.map((action) => {
    if (!action.toolId) {
      return {
        actionType: action.type,
        description: action.description,
        executionPlane: action.executionPlane,
        longRunning: action.longRunning,
        inputHints: action.inputHints,
        allowed: true
      } satisfies RuntimeToolManifestEntry;
    }

    if (!includeToolId(action.toolId)) {
      return {
        actionType: action.type,
        toolId: action.toolId,
        description: action.description,
        executionPlane: action.executionPlane,
        longRunning: action.longRunning,
        inputHints: action.inputHints,
        allowed: false,
        reason: "excluded_by_runtime_filter"
      } satisfies RuntimeToolManifestEntry;
    }

    const decision = input.evaluateToolPolicy(action.toolId);
    const schema = TOOL_INPUT_SCHEMAS_V1[action.toolId];
    return {
      actionType: action.type,
      toolId: action.toolId,
      description: action.description,
      executionPlane: action.executionPlane,
      longRunning: action.longRunning,
      inputHints: action.inputHints,
      allowed: decision.allowed,
      requiresApproval: decision.requiresApproval,
      safetyTier: decision.spec.safetyTier,
      capability: decision.spec.capability,
      reason: decision.reason,
      inputJsonSchema: schema ? z.toJSONSchema(schema) : undefined
    } satisfies RuntimeToolManifestEntry;
  });
}

export function buildCompactRuntimeToolManifest(entries: RuntimeToolManifestEntry[]): Array<{
  actionType: RuntimeToolManifestEntry["actionType"];
  toolId?: ToolId;
  allowed: boolean;
  requiresApproval?: boolean;
  executionPlane?: RuntimeToolManifestEntry["executionPlane"];
}> {
  return entries.map((entry) => ({
    actionType: entry.actionType,
    toolId: entry.toolId,
    allowed: entry.allowed,
    requiresApproval: entry.requiresApproval,
    executionPlane: entry.executionPlane
  }));
}
