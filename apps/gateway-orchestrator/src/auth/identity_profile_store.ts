import fs from "node:fs/promises";
import path from "node:path";

export type IdentityMapping = {
  whatsAppJid: string;
  authSessionId: string;
  updatedAt: string;
};

type IdentityMappingState = {
  mappings: IdentityMapping[];
};

function normalizeJid(value: string): string {
  return value.trim().toLowerCase();
}

export class IdentityProfileStore {
  private readonly filePath: string;
  private readonly maxMappings: number;

  constructor(stateDir: string, maxMappings = 2000) {
    this.filePath = path.join(stateDir, "auth", "identity_profiles.json");
    this.maxMappings = maxMappings;
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify({ mappings: [] }, null, 2), "utf8");
    }
  }

  async setMapping(whatsAppJid: string, authSessionId: string): Promise<IdentityMapping> {
    const jid = normalizeJid(whatsAppJid);
    const profile = authSessionId.trim();
    if (!jid) {
      throw new Error("identity_mapping_missing_whatsapp_jid");
    }
    if (!profile) {
      throw new Error("identity_mapping_missing_auth_session_id");
    }

    const state = await this.read();
    const now = new Date().toISOString();
    const next: IdentityMapping = {
      whatsAppJid: jid,
      authSessionId: profile,
      updatedAt: now
    };

    const idx = state.mappings.findIndex((item) => item.whatsAppJid === jid);
    if (idx >= 0) {
      state.mappings[idx] = next;
    } else {
      state.mappings.push(next);
      if (state.mappings.length > this.maxMappings) {
        state.mappings = state.mappings.slice(state.mappings.length - this.maxMappings);
      }
    }

    await this.write(state);
    return next;
  }

  async resolveAuthSession(whatsAppJid: string): Promise<string> {
    const jid = normalizeJid(whatsAppJid);
    if (!jid) {
      return whatsAppJid;
    }

    const state = await this.read();
    const existing = state.mappings.find((item) => item.whatsAppJid === jid);
    if (existing) {
      return existing.authSessionId;
    }

    await this.setMapping(jid, jid);
    return jid;
  }

  async getMapping(whatsAppJid: string): Promise<IdentityMapping | null> {
    const jid = normalizeJid(whatsAppJid);
    const state = await this.read();
    return state.mappings.find((item) => item.whatsAppJid === jid) ?? null;
  }

  async listMappings(limit = 200): Promise<IdentityMapping[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
    const state = await this.read();
    if (state.mappings.length <= bounded) {
      return state.mappings;
    }
    return state.mappings.slice(state.mappings.length - bounded);
  }

  private async read(): Promise<IdentityMappingState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<IdentityMappingState>;
    if (!parsed || !Array.isArray(parsed.mappings)) {
      return { mappings: [] };
    }
    return {
      mappings: parsed.mappings
        .filter((item) => !!item && typeof item === "object")
        .map((item) => ({
          whatsAppJid: typeof item.whatsAppJid === "string" ? normalizeJid(item.whatsAppJid) : "",
          authSessionId: typeof item.authSessionId === "string" ? item.authSessionId : "",
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
        }))
        .filter((item) => item.whatsAppJid.length > 0 && item.authSessionId.length > 0)
    };
  }

  private async write(state: IdentityMappingState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
