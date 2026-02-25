import fs from "node:fs/promises";
import path from "node:path";

export class SystemPromptCatalog {
  private readonly rootDir: string;
  private readonly files: string[];
  private cache: string | null = null;

  constructor(rootDir: string, files: string[]) {
    this.rootDir = path.resolve(rootDir);
    this.files = files;
  }

  async load(force = false): Promise<string> {
    if (this.cache && !force) {
      return this.cache;
    }

    const sections: string[] = [];
    for (const relativePath of this.files) {
      const resolved = path.resolve(this.rootDir, relativePath);
      let content = "";
      try {
        content = await fs.readFile(resolved, "utf8");
      } catch {
        continue;
      }
      const cleaned = content.trim();
      if (!cleaned) {
        continue;
      }
      sections.push(`## ${relativePath}\n${cleaned}`);
    }

    this.cache =
      sections.length > 0
        ? sections.join("\n\n")
        : "You are Alfred. Be concise, safe, and ask for clarification when uncertain.";

    return this.cache;
  }
}
