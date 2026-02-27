export type ExternalCapability = "web_search" | "file_write" | "shell_exec" | "wasm_exec";
export type ToolId = "web.search" | "file.write" | "file.send" | "shell.exec" | "wasm.exec";
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
  fileWriteEnabled: boolean;
  fileWriteRequireApproval: boolean;
  fileWriteApprovalMode: "per_action" | "session" | "always";
  shellEnabled: boolean;
  wasmEnabled: boolean;
};

export type ToolPolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  spec: ToolSpecV1;
};

export const TOOL_SPECS_V1: Record<ToolId, ToolSpecV1> = {
  "web.search": {
    version: 1,
    toolId: "web.search",
    capability: "web_search",
    safetyTier: "read_only",
    description: "Fetches web search results from configured providers."
  },
  "file.write": {
    version: 1,
    toolId: "file.write",
    capability: "file_write",
    safetyTier: "side_effecting",
    description: "Appends text to workspace files within policy bounds."
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
  "wasm.exec": {
    version: 1,
    toolId: "wasm.exec",
    capability: "wasm_exec",
    safetyTier: "privileged",
    description: "Reserved runtime surface for sandboxed WASM guest execution."
  }
};

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

  if (spec.capability === "file_write") {
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
    if (!baseRequiresApproval) {
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
