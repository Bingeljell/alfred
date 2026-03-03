import { AGENT_ACTION_SPECS_V1, TOOL_SPECS_V1 } from "../../../../tools/_core/registry";
import type {
  AgentActionSpecV1,
  AgentActionType,
  ExternalCapability,
  ToolId,
  ToolPolicyDecision,
  ToolPolicyInput,
  ToolSpecV1
} from "../../../../tools/_core/types";

export type {
  AgentActionSpecV1,
  AgentActionType,
  ExternalCapability,
  ToolId,
  ToolPolicyDecision,
  ToolPolicyInput,
  ToolSpecV1
};

export { TOOL_SPECS_V1 };

export function listAgentActionSpecs(input: {
  policy: ToolPolicyInput;
  context?: {
    hasFileWriteLease?: boolean;
  };
  includeToolId?: (toolId: ToolId) => boolean;
}): AgentActionSpecV1[] {
  const includeToolId = input.includeToolId ?? (() => true);
  const allowedToolActions = AGENT_ACTION_SPECS_V1.filter((spec) => {
    if (!spec.toolId) {
      return true;
    }
    if (!includeToolId(spec.toolId)) {
      return false;
    }
    const decision = evaluateToolPolicy(spec.toolId, input.policy, input.context);
    return decision.allowed;
  });
  return allowedToolActions;
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
