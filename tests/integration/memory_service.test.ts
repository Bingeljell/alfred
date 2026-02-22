import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicEmbeddingProvider, MemoryService } from "../../packages/memory/src";

describe("MemoryService integration", () => {
  it("indexes markdown memory and returns cited search results", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-memory-int-"));
    const stateDir = path.join(rootDir, "state");
    const memoryDir = path.join(rootDir, "memory");

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "MEMORY.md"), "Preferred deploy target: low-cost VM.", "utf8");
    await fs.writeFile(
      path.join(memoryDir, "2026-02-22.md"),
      [
        "- We decided to use Baileys for WhatsApp integration.",
        "- Async jobs should not block normal chat responses."
      ].join("\n"),
      "utf8"
    );

    const memory = new MemoryService({
      rootDir,
      stateDir,
      embeddingProvider: new DeterministicEmbeddingProvider(),
      enableWatch: false,
      syncIntervalMs: 60_000
    });

    await memory.start();

    const results = await memory.searchMemory("what did we choose for whatsapp", {
      maxResults: 5,
      minScore: 0
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain(":");
    expect(results.some((result) => result.snippet.toLowerCase().includes("baileys"))).toBe(true);

    const snippet = await memory.getMemorySnippet("memory/2026-02-22.md", 1, 1);
    expect(snippet.toLowerCase()).toContain("baileys");

    await memory.appendMemoryNote("Remember to run backup on Sunday.", "2026-02-23");
    const afterAppend = await memory.searchMemory("backup on sunday", {
      maxResults: 5,
      minScore: 0
    });

    expect(afterAppend.some((result) => result.path.endsWith("memory/2026-02-23.md"))).toBe(true);

    const status = memory.memoryStatus();
    expect(status.indexedFileCount).toBeGreaterThan(0);
    expect(status.chunkCount).toBeGreaterThan(0);

    await memory.stop();
  });
});
