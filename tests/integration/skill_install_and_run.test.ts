import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillInstaller, SkillRegistry, SkillRunner } from "../../packages/skill-runner/src";
import { createTempSkillRepo } from "../helpers/skill_repo";

describe("skill install and run integration", () => {
  it("installs allowlisted git skill pinned to commit and runs it", async () => {
    const { repoDir, commitSha } = await createTempSkillRepo();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-skill-int-"));

    const registry = new SkillRegistry(path.join(root, "registry", "skills.json"));
    const installer = new SkillInstaller(registry, path.join(root, "skills"), [repoDir]);
    const runner = new SkillRunner(registry);

    const installed = await installer.installFromGit({
      repo: repoDir,
      ref: "HEAD"
    });

    expect(installed.commitSha).toBe(commitSha);
    expect(installed.name).toBe("echo-skill");

    const success = await runner.run({
      name: installed.name,
      commitSha: installed.commitSha,
      workspaceDir: path.join(root, "workspace"),
      input: { action: "hello" },
      sessionId: "owner@s.whatsapp.net"
    });

    expect(success.status).toBe("success");
    if (success.status === "success") {
      expect(String(success.output.summary)).toBe("skill:hello");
    }

    const failure = await runner.run({
      name: installed.name,
      commitSha: installed.commitSha,
      workspaceDir: path.join(root, "workspace"),
      input: { forceFail: true }
    });

    expect(failure.status).toBe("failed");
    if (failure.status === "failed") {
      expect(failure.error.code).toBe("forced_failure");
    }
  });
});
