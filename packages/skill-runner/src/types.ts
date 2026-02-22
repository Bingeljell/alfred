import type { SkillManifest, SkillStructuredError } from "../../contracts/src";

export type InstalledSkillRecord = {
  name: string;
  version: string;
  sourceRepo: string;
  commitSha: string;
  installedAt: string;
  skillRoot: string;
  manifestPath: string;
  manifest: SkillManifest;
};

export type SkillInstallInput = {
  repo: string;
  ref?: string;
  subdir?: string;
};

export type SkillRunInput = {
  name: string;
  commitSha: string;
  workspaceDir: string;
  input: Record<string, unknown>;
  sessionId?: string;
};

export type SkillRunResult =
  | {
      status: "success";
      output: Record<string, unknown>;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "failed";
      error: SkillStructuredError;
      stdout: string;
      stderr: string;
      durationMs: number;
    };
