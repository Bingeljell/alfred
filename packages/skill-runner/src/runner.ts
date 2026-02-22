import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SkillStructuredErrorSchema } from "../../contracts/src";
import { assertWithinWorkspace, validateManifestSecurity } from "./security";
import { SkillRegistry } from "./registry";
import type { SkillRunInput, SkillRunResult } from "./types";

function replaceTokens(value: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [key, tokenValue]) => {
    return acc.replaceAll(`{${key}}`, tokenValue);
  }, value);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SkillRunner {
  constructor(private readonly registry: SkillRegistry) {}

  async run(input: SkillRunInput): Promise<SkillRunResult> {
    const installed = await this.registry.find(input.name, input.commitSha);
    if (!installed) {
      throw new Error(`Skill not installed: ${input.name}@${input.commitSha}`);
    }

    validateManifestSecurity(installed.manifest);

    const workspace = path.resolve(input.workspaceDir);
    await fs.mkdir(workspace, { recursive: true });

    const runDir = path.join(workspace, `run-${Date.now()}-${randomUUID()}`);
    await fs.mkdir(runDir, { recursive: true });

    assertWithinWorkspace(workspace, runDir);

    const inputPath = path.join(runDir, "input.json");
    const outputPath = path.join(runDir, "output.json");
    const errorPath = path.join(runDir, "error.json");

    await fs.writeFile(inputPath, JSON.stringify(input.input, null, 2), "utf8");

    const vars = {
      input: inputPath,
      output: outputPath,
      error: errorPath,
      workspace: runDir
    };

    const args = installed.manifest.entry.args.map((arg) => replaceTokens(arg, vars));
    const command = replaceTokens(installed.manifest.entry.command, vars);

    const cwd = installed.manifest.entry.cwd
      ? path.resolve(installed.skillRoot, installed.manifest.entry.cwd)
      : installed.skillRoot;

    const timeoutMs = installed.manifest.permissions.timeoutMs;
    const startedAt = Date.now();

    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          SKILL_NETWORK_MODE: "deny_by_default",
          SKILL_NETWORK_ALLOWLIST: installed.manifest.permissions.network.allowlist.join(","),
          SKILL_SESSION_ID: input.sessionId ?? ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (data) => {
        stdout += String(data);
      });

      child.stderr.on("data", (data) => {
        stderr += String(data);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

    const durationMs = Date.now() - startedAt;

    if (result.timedOut) {
      return {
        status: "failed",
        error: {
          code: "timeout",
          message: `Skill execution exceeded timeout ${timeoutMs}ms`,
          retryable: false
        },
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs
      };
    }

    if (result.code === 0) {
      const output = (await readJsonIfExists(outputPath)) ?? {};
      return {
        status: "success",
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs
      };
    }

    const structured = await readJsonIfExists(errorPath);
    if (structured) {
      const parsed = SkillStructuredErrorSchema.safeParse(structured);
      if (parsed.success) {
        return {
          status: "failed",
          error: parsed.data,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs
        };
      }
    }

    return {
      status: "failed",
      error: {
        code: "non_zero_exit",
        message: `Skill exited with code ${String(result.code)}`,
        retryable: false,
        details: {
          stderr: result.stderr.slice(0, 1000)
        }
      },
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs
    };
  }
}
