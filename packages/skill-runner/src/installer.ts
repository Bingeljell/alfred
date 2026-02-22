import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SkillManifestSchema, type SkillManifest } from "../../contracts/src";
import { isRepoAllowed, validateManifestSecurity } from "./security";
import { SkillRegistry } from "./registry";
import type { InstalledSkillRecord, SkillInstallInput } from "./types";

const execFileAsync = promisify(execFile);

function isLikelyLocalRepo(repo: string): boolean {
  return repo.startsWith("/") || repo.startsWith("./") || repo.startsWith("../") || repo.includes(path.sep);
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

export class SkillInstaller {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly installRoot: string,
    private readonly allowlistedRepos: string[]
  ) {}

  async installFromGit(input: SkillInstallInput): Promise<InstalledSkillRecord> {
    const repo = input.repo.trim();
    const ref = input.ref ?? "HEAD";

    if (!isRepoAllowed(repo, this.allowlistedRepos)) {
      throw new Error(`Repository is not allowlisted: ${repo}`);
    }

    const commitSha = await this.resolveCommitSha(repo, ref);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-skill-install-"));
    const cloneDir = path.join(tempDir, randomUUID());

    await runGit(["clone", repo, cloneDir]);
    await runGit(["-C", cloneDir, "checkout", commitSha]);

    const subdir = input.subdir ?? ".";
    const sourceRoot = path.resolve(cloneDir, subdir);
    const manifestPath = path.join(sourceRoot, "skill.json");

    const manifest = await this.readManifest(manifestPath);
    validateManifestSecurity(manifest);

    const destination = path.join(this.installRoot, manifest.name, commitSha);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(sourceRoot, destination, { recursive: true });

    const record: InstalledSkillRecord = {
      name: manifest.name,
      version: manifest.version,
      sourceRepo: repo,
      commitSha,
      installedAt: new Date().toISOString(),
      skillRoot: destination,
      manifestPath: path.join(destination, "skill.json"),
      manifest
    };

    await this.registry.upsert(record);
    await fs.rm(tempDir, { recursive: true, force: true });

    return record;
  }

  private async resolveCommitSha(repo: string, ref: string): Promise<string> {
    if (isLikelyLocalRepo(repo)) {
      const sha = await runGit(["-C", path.resolve(repo), "rev-parse", ref]);
      return sha.split("\n")[0].trim();
    }

    const raw = await runGit(["ls-remote", repo, ref]);
    const line = raw.split("\n").find(Boolean);
    if (!line) {
      throw new Error(`Unable to resolve ref '${ref}' in repo '${repo}'`);
    }

    const [sha] = line.split(/\s+/);
    if (!sha) {
      throw new Error(`Unable to parse commit SHA from ls-remote output for '${repo}'`);
    }

    return sha;
  }

  private async readManifest(filePath: string): Promise<SkillManifest> {
    const raw = await fs.readFile(filePath, "utf8");
    return SkillManifestSchema.parse(JSON.parse(raw));
  }
}
