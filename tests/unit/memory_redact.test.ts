import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../packages/memory/src";

describe("redactSecrets", () => {
  it("redacts common secret-like values", () => {
    const input = "api_key=sk-abcdefghijklmnopqrstuvwxyz123456 token=verylongtokenvalue12345";
    const output = redactSecrets(input);

    expect(output).toContain("[REDACTED_SECRET]");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});
