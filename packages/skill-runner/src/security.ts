import path from "node:path";
import type { SkillManifest } from "../../contracts/src";

export function isRepoAllowed(repo: string, allowlist: string[]): boolean {
  const normalizedRepo = repo.trim();
  return allowlist.some((entry) => {
    const normalizedEntry = entry.trim();
    return normalizedRepo === normalizedEntry || normalizedRepo.startsWith(normalizedEntry);
  });
}

export function validateManifestSecurity(manifest: SkillManifest): void {
  const paths = [...manifest.permissions.fs.read, ...manifest.permissions.fs.write];

  for (const candidate of paths) {
    if (path.isAbsolute(candidate)) {
      throw new Error(`Absolute filesystem path is not allowed in manifest permissions: ${candidate}`);
    }

    if (candidate.split(/[\\/]/).includes("..")) {
      throw new Error(`Parent directory traversal is not allowed in manifest permissions: ${candidate}`);
    }
  }

  if (manifest.permissions.network.allowlist.includes("*")) {
    throw new Error("Network wildcard '*' is not allowed; explicit allowlist entries are required.");
  }
}

export function assertWithinWorkspace(workspaceDir: string, candidatePath: string): void {
  const workspace = path.resolve(workspaceDir);
  const resolved = path.resolve(candidatePath);

  if (!(resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`))) {
    throw new Error(`Path escapes workspace scope: ${resolved}`);
  }
}
