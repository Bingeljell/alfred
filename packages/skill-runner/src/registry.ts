import fs from "node:fs/promises";
import path from "node:path";
import type { InstalledSkillRecord } from "./types";

type SkillRegistryShape = {
  installed: InstalledSkillRecord[];
};

export class SkillRegistry {
  constructor(private readonly registryPath: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    try {
      await fs.access(this.registryPath);
    } catch {
      await fs.writeFile(this.registryPath, JSON.stringify({ installed: [] }, null, 2), "utf8");
    }
  }

  async list(): Promise<InstalledSkillRecord[]> {
    await this.ensureReady();
    const state = await this.read();
    return state.installed.slice();
  }

  async find(name: string, commitSha: string): Promise<InstalledSkillRecord | null> {
    const all = await this.list();
    return all.find((record) => record.name === name && record.commitSha === commitSha) ?? null;
  }

  async upsert(record: InstalledSkillRecord): Promise<void> {
    await this.ensureReady();
    const state = await this.read();
    const next = state.installed.filter((item) => !(item.name === record.name && item.commitSha === record.commitSha));
    next.push(record);
    await this.write({ installed: next });
  }

  private async read(): Promise<SkillRegistryShape> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as SkillRegistryShape;
      if (!parsed || !Array.isArray(parsed.installed)) {
        return { installed: [] };
      }
      return parsed;
    } catch {
      return { installed: [] };
    }
  }

  private async write(state: SkillRegistryShape): Promise<void> {
    const temp = `${this.registryPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.registryPath);
  }
}
