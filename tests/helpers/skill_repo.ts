import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SkillManifest } from "../../packages/contracts/src";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

export async function createTempSkillRepo(options?: {
  manifestOverrides?: Partial<SkillManifest>;
}): Promise<{ repoDir: string; commitSha: string; manifest: SkillManifest }> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-skill-repo-"));

  const manifest: SkillManifest = {
    name: "echo-skill",
    version: "0.1.0",
    description: "Echoes input action",
    entry: {
      command: "node",
      args: ["run.js", "{input}", "{output}", "{error}"]
    },
    permissions: {
      fs: { read: [], write: [] },
      network: { allowlist: [] },
      timeoutMs: 5000
    },
    ...(options?.manifestOverrides ?? {})
  };

  const runJs = [
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
    "const outPath = process.argv[3];",
    "const errPath = process.argv[4];",
    "if (input.forceFail) {",
    "  fs.writeFileSync(errPath, JSON.stringify({ code: 'forced_failure', message: 'forced', retryable: false }));",
    "  process.exit(1);",
    "}",
    "fs.writeFileSync(outPath, JSON.stringify({ summary: `skill:${String(input.action || 'none')}` }));"
  ].join("\n");

  await fs.writeFile(path.join(repoDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(path.join(repoDir, "run.js"), runJs, "utf8");

  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.name", "Alfred Test"]);
  runGit(repoDir, ["config", "user.email", "alfred-test@example.com"]);
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "initial skill commit"]);

  const commitSha = runGit(repoDir, ["rev-parse", "HEAD"]);
  return { repoDir, commitSha, manifest };
}
