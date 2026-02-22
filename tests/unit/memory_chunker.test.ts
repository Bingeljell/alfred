import { describe, expect, it } from "vitest";
import { chunkByApproxTokens } from "../../packages/memory/src";

describe("chunkByApproxTokens", () => {
  it("creates token-bounded chunks with overlap", () => {
    const input = [
      "line one alpha beta gamma",
      "line two alpha beta gamma",
      "line three alpha beta gamma",
      "line four alpha beta gamma",
      "line five alpha beta gamma"
    ].join("\n");

    const chunks = chunkByApproxTokens(input, {
      pathKey: "memory/2026-02-22.md",
      targetTokens: 10,
      overlapTokens: 4
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[0].startLine);
    expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
  });
});
