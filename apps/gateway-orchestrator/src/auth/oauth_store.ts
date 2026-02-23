import fs from "node:fs/promises";
import path from "node:path";
import type { EncodedSecret } from "./oauth_codec";

export type OAuthProvider = "openai";

export type OAuthTokenRecord = {
  sessionId: string;
  provider: OAuthProvider;
  secret: EncodedSecret;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  scope?: string;
};

export type OAuthPendingStateRecord = {
  state: string;
  sessionId: string;
  provider: OAuthProvider;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
};

type OAuthState = {
  pending: OAuthPendingStateRecord[];
  tokens: OAuthTokenRecord[];
};

function isExpired(iso: string, now = Date.now()): boolean {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) || ts <= now;
}

export class OAuthStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "auth", "oauth_state.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write({ pending: [], tokens: [] });
    }
  }

  async addPending(record: OAuthPendingStateRecord): Promise<void> {
    const state = await this.read();
    state.pending = state.pending.filter((item) => !isExpired(item.expiresAt));
    state.pending.push(record);
    await this.write(state);
  }

  async hasPending(provider: OAuthProvider, pendingState: string): Promise<boolean> {
    const state = await this.read();
    return state.pending.some(
      (item) => item.provider === provider && item.state === pendingState && !isExpired(item.expiresAt)
    );
  }

  async consumePending(provider: OAuthProvider, pendingState: string): Promise<OAuthPendingStateRecord | null> {
    const state = await this.read();
    const now = Date.now();

    const nextPending: OAuthPendingStateRecord[] = [];
    let matched: OAuthPendingStateRecord | null = null;
    for (const item of state.pending) {
      if (isExpired(item.expiresAt, now)) {
        continue;
      }

      if (!matched && item.provider === provider && item.state === pendingState) {
        matched = item;
        continue;
      }

      nextPending.push(item);
    }

    state.pending = nextPending;
    await this.write(state);
    return matched;
  }

  async upsertToken(record: OAuthTokenRecord): Promise<void> {
    const state = await this.read();
    const idx = state.tokens.findIndex((item) => item.provider === record.provider && item.sessionId === record.sessionId);
    if (idx >= 0) {
      const prev = state.tokens[idx];
      state.tokens[idx] = {
        ...record,
        createdAt: prev.createdAt
      };
    } else {
      state.tokens.push(record);
    }
    await this.write(state);
  }

  async getToken(provider: OAuthProvider, sessionId: string): Promise<OAuthTokenRecord | null> {
    const state = await this.read();
    const token = state.tokens.find((item) => item.provider === provider && item.sessionId === sessionId);
    return token ?? null;
  }

  async deleteToken(provider: OAuthProvider, sessionId: string): Promise<boolean> {
    const state = await this.read();
    const before = state.tokens.length;
    state.tokens = state.tokens.filter((item) => !(item.provider === provider && item.sessionId === sessionId));
    if (state.tokens.length === before) {
      return false;
    }
    await this.write(state);
    return true;
  }

  private async read(): Promise<OAuthState> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OAuthState>;
    const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
    const tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return {
      pending,
      tokens
    };
  }

  private async write(state: OAuthState): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}
