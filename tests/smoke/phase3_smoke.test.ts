import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicEmbeddingProvider, MemoryService } from "../../packages/memory/src";

describe("phase 3 smoke", () => {
  it("meets baseline recall target on project decision snippets", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-memory-smoke-"));
    const stateDir = path.join(rootDir, "state");
    const memoryDir = path.join(rootDir, "memory");

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "MEMORY.md"), "Primary deployment starts on a single host machine.", "utf8");
    await fs.writeFile(
      path.join(memoryDir, "2026-02-22.md"),
      [
        "We selected TypeScript/Node for v1 runtime.",
        "We selected Baileys as the WhatsApp connector.",
        "We require source citations in factual memory recall."
      ].join("\n"),
      "utf8"
    );

    const service = new MemoryService({
      rootDir,
      stateDir,
      embeddingProvider: new DeterministicEmbeddingProvider(),
      enableWatch: false,
      syncIntervalMs: 60_000
    });

    await service.start();

    const evalSet: Array<{ query: string; expected: string }> = [
      { query: "what runtime did we choose", expected: "TypeScript/Node" },
      { query: "which whatsapp connector", expected: "Baileys" },
      { query: "what should factual recall include", expected: "citations" },
      { query: "where is deployment starting", expected: "single host" },
      { query: "what stack for v1", expected: "TypeScript/Node" }
    ];

    let hits = 0;
    for (const testCase of evalSet) {
      const results = await service.searchMemory(testCase.query, { maxResults: 5, minScore: 0 });
      const matched = results.some((result) => result.snippet.toLowerCase().includes(testCase.expected.toLowerCase()));
      if (matched) {
        hits += 1;
      }
    }

    const hitRate = hits / evalSet.length;
    expect(hitRate).toBeGreaterThanOrEqual(0.8);

    await service.stop();
  });
});
