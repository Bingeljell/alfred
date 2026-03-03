export type ExternalCapability = "web_search" | "file_read" | "file_write" | "shell_exec" | "wasm_exec";

export type ToolId =
  | "web.search"
  | "web.fetch"
  | "web.extract"
  | "file.read"
  | "file.read.range"
  | "file.write"
  | "file.edit"
  | "file.send"
  | "shell.exec"
  | "process.list"
  | "process.kill"
  | "process.start"
  | "process.wait"
  | "wasm.exec";

export type ToolSafetyTier = "read_only" | "side_effecting" | "privileged";

export type ToolSpecV1 = {
  version: 1;
  toolId: ToolId;
  capability: ExternalCapability;
  safetyTier: ToolSafetyTier;
  description: string;
};

export type ToolPolicyInput = {
  approvalMode: "step" | "general" | "strict" | "balanced" | "relaxed";
  approvalDefault: boolean;
  webSearchEnabled: boolean;
  webSearchRequireApproval: boolean;
  fileReadEnabled: boolean;
  fileWriteEnabled: boolean;
  fileWriteRequireApproval: boolean;
  fileWriteApprovalMode: "per_action" | "session" | "always";
  fileEditEnabled: boolean;
  fileEditRequireApproval: boolean;
  shellEnabled: boolean;
  wasmEnabled: boolean;
};

export type ToolPolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  spec: ToolSpecV1;
};

export type ExecutionPlane = "gateway" | "worker" | "either";

export type AgentActionType =
  | "none"
  | "ask_user"
  | "web.search"
  | "web.fetch"
  | "web.extract"
  | "file.read.range"
  | "shell.exec"
  | "process.list"
  | "process.kill"
  | "process.start"
  | "process.wait"
  | "worker.run";

export type AgentActionSpecV1 = {
  version: 1;
  type: AgentActionType;
  description: string;
  toolId?: ToolId;
  longRunning?: boolean;
  executionPlane?: ExecutionPlane;
  inputHints?: string[];
};
