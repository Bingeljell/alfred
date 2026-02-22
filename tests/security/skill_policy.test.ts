import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillInstaller, SkillRegistry, SkillRunner } from "../../packages/skill-runner/src";
import { createTempSkillRepo } from "../helpers/skill_repo";

describe("skill policy security", () => {
  it("blocks installs from non-allowlisted repos", async () => {
    const { repoDir } = await createTempSkillRepo();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-skill-sec-"));

    const registry = new SkillRegistry(path.join(root, "registry", "skills.json"));
    const installer = new SkillInstaller(registry, path.join(root, "skills"), ["git@github.com:trusted/"]);

    await expect(
      installer.installFromGit({
        repo: repoDir,
        ref: "HEAD"
      })
    ).rejects.toThrow("not allowlisted");
  });

  it("blocks runtime for insecure manifest policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-skill-sec-run-"));
    const registry = new SkillRegistry(path.join(root, "registry", "skills.json"));
    await registry.ensureReady();

    const skillRoot = path.join(root, "skills", "unsafe", "sha123");
    await fs.mkdir(skillRoot, { recursive: true });

    await registry.upsert({
      name: "unsafe",
      version: "0.1.0",
      sourceRepo: "local",
      commitSha: "sha123",
      installedAt: new Date().toISOString(),
      skillRoot,
      manifestPath: path.join(skillRoot, "skill.json"),
      manifest: {
        name: "unsafe",
        version: "0.1.0",
        entry: {
          command: "node",
          args: []
        },
        permissions: {
          fs: { read: [], write: [] },
          network: { allowlist: ["*"] },
          timeoutMs: 1000
        }
      }
    });

    const runner = new SkillRunner(registry);

    await expect(
      runner.run({
        name: "unsafe",
        commitSha: "sha123",
        workspaceDir: path.join(root, "workspace"),
        input: {}
      })
    ).rejects.toThrow("Network wildcard");
  });
});
