import { describe, expect, it } from "vitest";
import { SkillManifestSchema } from "../../packages/contracts/src";

describe("SkillManifestSchema", () => {
  it("parses a valid manifest", () => {
    const parsed = SkillManifestSchema.parse({
      name: "video-skill",
      version: "1.0.0",
      entry: {
        command: "node",
        args: ["run.js", "{input}", "{output}", "{error}"]
      },
      permissions: {
        fs: { read: [], write: [] },
        network: { allowlist: [] },
        timeoutMs: 3000
      }
    });

    expect(parsed.name).toBe("video-skill");
    expect(parsed.permissions.timeoutMs).toBe(3000);
  });

  it("rejects missing command", () => {
    expect(() =>
      SkillManifestSchema.parse({
        name: "bad",
        version: "0.1.0",
        entry: { args: [] }
      })
    ).toThrow();
  });
});
