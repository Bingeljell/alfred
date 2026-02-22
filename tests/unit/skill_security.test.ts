import { describe, expect, it } from "vitest";
import { isRepoAllowed, validateManifestSecurity } from "../../packages/skill-runner/src";

describe("skill security", () => {
  it("matches allowlisted repos", () => {
    expect(isRepoAllowed("git@github.com:Bingeljell/videoclipper.git", ["git@github.com:Bingeljell/"])).toBe(true);
    expect(isRepoAllowed("https://github.com/acme/other.git", ["git@github.com:Bingeljell/"])).toBe(false);
  });

  it("rejects wildcard network allowlist", () => {
    expect(() =>
      validateManifestSecurity({
        name: "bad-network",
        version: "0.1.0",
        entry: { command: "node", args: [] },
        permissions: {
          fs: { read: [], write: [] },
          network: { allowlist: ["*"] },
          timeoutMs: 1000
        }
      })
    ).toThrow();
  });

  it("rejects path traversal permissions", () => {
    expect(() =>
      validateManifestSecurity({
        name: "bad-fs",
        version: "0.1.0",
        entry: { command: "node", args: [] },
        permissions: {
          fs: { read: ["../secret"], write: [] },
          network: { allowlist: [] },
          timeoutMs: 1000
        }
      })
    ).toThrow();
  });
});
