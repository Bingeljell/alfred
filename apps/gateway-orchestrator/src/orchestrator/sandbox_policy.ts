export type SandboxTarget = "shell.exec" | "wasm.exec";

export type SandboxPolicyConfig = {
  shellEnabled: boolean;
  wasmEnabled: boolean;
};

export type ShellBlockRule = {
  id: string;
  pattern: RegExp;
};

export const DEFAULT_SHELL_BLOCK_RULES: ShellBlockRule[] = [
  { id: "dangerous_rm_root", pattern: /\brm\s+-rf\s+\/(\s|$)/i },
  { id: "fork_bomb", pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\};:/i },
  { id: "privilege_escalation", pattern: /\b(sudo|su)\b/i },
  { id: "disk_format", pattern: /\b(mkfs|fdisk|diskutil\s+eraseDisk)\b/i },
  { id: "raw_device_write", pattern: /\bdd\s+if=.*\sof=\/dev\//i },
  { id: "shutdown_reboot", pattern: /\b(shutdown|reboot|halt)\b/i },
  { id: "curl_pipe_shell", pattern: /\bcurl\b[^|]*\|\s*(bash|sh)\b/i },
  { id: "wget_pipe_shell", pattern: /\bwget\b[^|]*\|\s*(bash|sh)\b/i }
];

export function isSandboxTargetEnabled(target: SandboxTarget, config: SandboxPolicyConfig): boolean {
  if (target === "shell.exec") {
    return config.shellEnabled;
  }
  return config.wasmEnabled;
}

export function evaluateShellCommandPolicy(
  command: string,
  rules: ShellBlockRule[] = DEFAULT_SHELL_BLOCK_RULES
): { blocked: false } | { blocked: true; ruleId: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { blocked: true, ruleId: "empty_command" };
  }
  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return {
        blocked: true,
        ruleId: rule.id
      };
    }
  }
  return { blocked: false };
}
