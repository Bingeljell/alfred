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
  approvalMode: "strict" | "balanced" | "relaxed";
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
};

export const TOOL_SPECS_V1: Record<ToolId, ToolSpecV1> = {
  "web.search": {
    version: 1,
    toolId: "web.search",
    capability: "web_search",
    safetyTier: "read_only",
    description: "Fetches web search results from configured providers."
  },
  "web.fetch": {
    version: 1,
    toolId: "web.fetch",
    capability: "web_search",
    safetyTier: "read_only",
    description: "Fetches and normalizes web page content from a URL."
  },
  "web.extract": {
    version: 1,
    toolId: "web.extract",
    capability: "web_search",
    safetyTier: "read_only",
    description: "Extracts structured evidence/summaries from fetched web pages."
  },
  "file.write": {
    version: 1,
    toolId: "file.write",
    capability: "file_write",
    safetyTier: "side_effecting",
    description: "Appends text to workspace files within policy bounds."
  },
  "file.read": {
    version: 1,
    toolId: "file.read",
    capability: "file_read",
    safetyTier: "read_only",
    description: "Reads file content within configured allowlisted roots."
  },
  "file.read.range": {
    version: 1,
    toolId: "file.read.range",
    capability: "file_read",
    safetyTier: "read_only",
    description: "Reads bounded line ranges from files within allowlisted roots."
  },
  "file.edit": {
    version: 1,
    toolId: "file.edit",
    capability: "file_write",
    safetyTier: "side_effecting",
    description: "Edits existing files with optional hash guards."
  },
  "file.send": {
    version: 1,
    toolId: "file.send",
    capability: "file_write",
    safetyTier: "side_effecting",
    description: "Sends workspace files as outbound channel attachments."
  },
  "shell.exec": {
    version: 1,
    toolId: "shell.exec",
    capability: "shell_exec",
    safetyTier: "privileged",
    description: "Executes shell commands inside the workspace policy boundary."
  },
  "process.list": {
    version: 1,
    toolId: "process.list",
    capability: "shell_exec",
    safetyTier: "read_only",
    description: "Lists running local processes with optional pattern filtering."
  },
  "process.kill": {
    version: 1,
    toolId: "process.kill",
    capability: "shell_exec",
    safetyTier: "privileged",
    description: "Stops local processes by PID or pattern with post-kill verification."
  },
  "process.start": {
    version: 1,
    toolId: "process.start",
    capability: "shell_exec",
    safetyTier: "privileged",
    description: "Starts a local process in the background with optional readiness checks."
  },
  "process.wait": {
    version: 1,
    toolId: "process.wait",
    capability: "shell_exec",
    safetyTier: "read_only",
    description: "Waits for local process readiness by PID/pattern/port."
  },
  "wasm.exec": {
    version: 1,
    toolId: "wasm.exec",
    capability: "wasm_exec",
    safetyTier: "privileged",
    description: "Reserved runtime surface for sandboxed WASM guest execution."
  }
};

const CORE_AGENT_ACTION_SPECS: AgentActionSpecV1[] = [
  {
    version: 1,
    type: "none",
    description: "Reply conversationally without external actions."
  },
  {
    version: 1,
    type: "ask_user",
    description: "Ask one concise clarification when critical details are missing."
  }
];

const TOOL_AGENT_ACTION_SPECS: AgentActionSpecV1[] = [
  {
    version: 1,
    type: "web.search",
    toolId: "web.search",
    description: "Run web retrieval for live/current information."
  },
  {
    version: 1,
    type: "web.fetch",
    toolId: "web.fetch",
    description: "Fetch and summarize a specific URL."
  },
  {
    version: 1,
    type: "web.extract",
    toolId: "web.extract",
    description: "Synthesize grounded findings from web evidence."
  },
  {
    version: 1,
    type: "file.read.range",
    toolId: "file.read.range",
    description: "Read bounded file lines within allowlisted roots."
  },
  {
    version: 1,
    type: "shell.exec",
    toolId: "shell.exec",
    description: "Execute a local shell command (approval-gated)."
  },
  {
    version: 1,
    type: "process.list",
    toolId: "process.list",
    description: "List running processes, optionally filtered by pattern."
  },
  {
    version: 1,
    type: "process.kill",
    toolId: "process.kill",
    description: "Terminate process(es) by PID or pattern (approval-gated)."
  },
  {
    version: 1,
    type: "process.start",
    toolId: "process.start",
    description: "Start a background process with verification checks (approval-gated)."
  },
  {
    version: 1,
    type: "process.wait",
    toolId: "process.wait",
    description: "Wait for process readiness via pid/pattern/port checks."
  },
  {
    version: 1,
    type: "worker.run",
    longRunning: true,
    description: "Delegate a long-running objective to worker execution."
  }
];

export function listAgentActionSpecs(input: {
  policy: ToolPolicyInput;
  context?: {
    hasFileWriteLease?: boolean;
  };
  includeToolId?: (toolId: ToolId) => boolean;
}): AgentActionSpecV1[] {
  const includeToolId = input.includeToolId ?? (() => true);
  const allowedToolActions = TOOL_AGENT_ACTION_SPECS.filter((spec) => {
    if (!spec.toolId) {
      return true;
    }
    if (!includeToolId(spec.toolId)) {
      return false;
    }
    const decision = evaluateToolPolicy(spec.toolId, input.policy, input.context);
    return decision.allowed;
  });
  return [...CORE_AGENT_ACTION_SPECS, ...allowedToolActions];
}

function requiresApprovalByMode(input: {
  capability: ExternalCapability;
  policy: ToolPolicyInput;
}): boolean {
  if (input.policy.approvalMode === "strict") {
    return true;
  }
  if (input.policy.approvalMode === "balanced") {
    return input.capability === "file_write";
  }
  if (!input.policy.approvalDefault) {
    return false;
  }
  if (input.capability === "web_search") {
    return input.policy.webSearchRequireApproval;
  }
  if (input.capability === "file_write") {
    return input.policy.fileWriteRequireApproval;
  }
  return true;
}

export function evaluateToolPolicy(
  toolId: ToolId,
  policy: ToolPolicyInput,
  context?: {
    hasFileWriteLease?: boolean;
  }
): ToolPolicyDecision {
  const spec = TOOL_SPECS_V1[toolId];
  if (spec.capability === "web_search") {
    if (!policy.webSearchEnabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Web search is disabled by policy.",
        spec
      };
    }
    return {
      allowed: true,
      requiresApproval: false,
      spec
    };
  }

  if (spec.capability === "file_read") {
    if (!policy.fileReadEnabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "File read is disabled by policy.",
        spec
      };
    }
    return {
      allowed: true,
      requiresApproval: false,
      spec
    };
  }

  if (spec.capability === "file_write") {
    if (toolId === "file.edit" && !policy.fileEditEnabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "File edit is disabled by policy.",
        spec
      };
    }
    if (!policy.fileWriteEnabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "File write is disabled by policy.",
        spec
      };
    }

    const baseRequiresApproval = requiresApprovalByMode({
      capability: "file_write",
      policy
    });
    const modeRequiresApproval = toolId === "file.edit" ? policy.fileEditRequireApproval : baseRequiresApproval;
    if (!modeRequiresApproval) {
      return {
        allowed: true,
        requiresApproval: false,
        spec
      };
    }
    if (policy.fileWriteApprovalMode === "always") {
      return {
        allowed: true,
        requiresApproval: false,
        spec
      };
    }
    if (policy.fileWriteApprovalMode === "session") {
      return {
        allowed: true,
        requiresApproval: context?.hasFileWriteLease ? false : true,
        spec
      };
    }
    return {
      allowed: true,
      requiresApproval: true,
      spec
    };
  }

  if (spec.capability === "shell_exec") {
    if (!policy.shellEnabled) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Shell execution is disabled by policy.",
        spec
      };
    }
    return {
      allowed: true,
      requiresApproval: false,
      spec
    };
  }

  return {
    allowed: policy.wasmEnabled,
    requiresApproval: false,
    reason: policy.wasmEnabled ? undefined : "WASM execution is not yet enabled in this runtime.",
    spec
  };
}
