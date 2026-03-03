import { z } from "zod";
import type { AgentActionSpecV1, ToolId, ToolSpecV1 } from "./types";

import * as webSearch from "../web_search/spec";
import * as webFetch from "../web_fetch/spec";
import * as webExtract from "../web_extract/spec";
import * as fileRead from "../file_read/spec";
import * as fileReadRange from "../file_read_range/spec";
import * as fileWrite from "../file_write/spec";
import * as fileEdit from "../file_edit/spec";
import * as fileSend from "../file_send/spec";
import * as shellExec from "../shell_exec/spec";
import * as processList from "../process_list/spec";
import * as processKill from "../process_kill/spec";
import * as processStart from "../process_start/spec";
import * as processWait from "../process_wait/spec";
import * as wasmExec from "../wasm_exec/spec";

export type ToolDefinition = {
  spec: ToolSpecV1;
  action?: AgentActionSpecV1;
  inputSchema?: z.ZodTypeAny;
};

const toolDefinitions: ToolDefinition[] = [
  { spec: webSearch.toolSpec, action: webSearch.actionSpec, inputSchema: webSearch.inputSchema },
  { spec: webFetch.toolSpec, action: webFetch.actionSpec, inputSchema: webFetch.inputSchema },
  { spec: webExtract.toolSpec, action: webExtract.actionSpec, inputSchema: webExtract.inputSchema },
  { spec: fileRead.toolSpec, inputSchema: fileRead.inputSchema },
  { spec: fileReadRange.toolSpec, action: fileReadRange.actionSpec, inputSchema: fileReadRange.inputSchema },
  { spec: fileWrite.toolSpec, inputSchema: fileWrite.inputSchema },
  { spec: fileEdit.toolSpec, inputSchema: fileEdit.inputSchema },
  { spec: fileSend.toolSpec, inputSchema: fileSend.inputSchema },
  { spec: shellExec.toolSpec, action: shellExec.actionSpec, inputSchema: shellExec.inputSchema },
  { spec: processList.toolSpec, action: processList.actionSpec, inputSchema: processList.inputSchema },
  { spec: processKill.toolSpec, action: processKill.actionSpec, inputSchema: processKill.inputSchema },
  { spec: processStart.toolSpec, action: processStart.actionSpec, inputSchema: processStart.inputSchema },
  { spec: processWait.toolSpec, action: processWait.actionSpec, inputSchema: processWait.inputSchema },
  { spec: wasmExec.toolSpec, inputSchema: wasmExec.inputSchema }
];

export const TOOL_SPECS_V1: Record<ToolId, ToolSpecV1> = Object.fromEntries(
  toolDefinitions.map((item) => [item.spec.toolId, item.spec])
) as Record<ToolId, ToolSpecV1>;

export const TOOL_INPUT_SCHEMAS_V1: Partial<Record<ToolId, z.ZodTypeAny>> = Object.fromEntries(
  toolDefinitions
    .filter((item) => Boolean(item.inputSchema))
    .map((item) => [item.spec.toolId, item.inputSchema as z.ZodTypeAny])
) as Partial<Record<ToolId, z.ZodTypeAny>>;

const CORE_AGENT_ACTION_SPECS: AgentActionSpecV1[] = [
  {
    version: 1,
    type: "none",
    executionPlane: "gateway",
    description: "Reply conversationally without external actions."
  },
  {
    version: 1,
    type: "ask_user",
    executionPlane: "gateway",
    description: "Ask one concise clarification when critical details are missing."
  }
];

const TOOL_AGENT_ACTION_SPECS: AgentActionSpecV1[] = toolDefinitions
  .filter((item): item is ToolDefinition & { action: AgentActionSpecV1 } => Boolean(item.action))
  .map((item) => item.action);

const WORKER_RUN_ACTION: AgentActionSpecV1 = {
  version: 1,
  type: "worker.run",
  executionPlane: "worker",
  longRunning: true,
  description: "Delegate a long-running objective to worker execution.",
  inputHints: ["goal", "query", "provider", "reason"]
};

export const AGENT_ACTION_SPECS_V1: AgentActionSpecV1[] = [
  ...CORE_AGENT_ACTION_SPECS,
  ...TOOL_AGENT_ACTION_SPECS,
  WORKER_RUN_ACTION
];

export function getToolInputSchema(toolId: ToolId): z.ZodTypeAny | undefined {
  return TOOL_INPUT_SCHEMAS_V1[toolId];
}

export function getActionSpecByType(type: string): AgentActionSpecV1 | undefined {
  return AGENT_ACTION_SPECS_V1.find((item) => item.type === type);
}
