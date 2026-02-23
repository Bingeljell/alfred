import fs from "node:fs/promises";
import path from "node:path";
import type { CodexAuthStatus } from "./auth_service";

export type CodexAuthTelemetry = {
  lastLogin: { loginId: string | null; success: boolean; error: string | null; at: string } | null;
  lastDisconnectAt: string | null;
  lastStatusCheckedAt: string | null;
  lastKnownConnected: boolean | null;
  lastKnownAuthMode: CodexAuthStatus["authMode"] | null;
  lastStatusError: { message: string; at: string } | null;
};

type AuthStateFile = {
  telemetry: CodexAuthTelemetry;
};

const DEFAULT_TELEMETRY: CodexAuthTelemetry = {
  lastLogin: null,
  lastDisconnectAt: null,
  lastStatusCheckedAt: null,
  lastKnownConnected: null,
  lastKnownAuthMode: null,
  lastStatusError: null
};

export class CodexAuthStateStore {
  private readonly filePath: string;
  private ioQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "codex", "auth_state.json");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write({ telemetry: { ...DEFAULT_TELEMETRY } });
    }
  }

  async readTelemetry(): Promise<CodexAuthTelemetry> {
    return this.withFileLock(async () => {
      const state = await this.read();
      return state.telemetry;
    });
  }

  async recordLogin(result: { loginId: string | null; success: boolean; error: string | null }): Promise<void> {
    await this.withFileLock(async () => {
      await this.update((telemetry) => ({
        ...telemetry,
        lastLogin: {
          loginId: result.loginId,
          success: result.success,
          error: result.error,
          at: new Date().toISOString()
        }
      }));
    });
  }

  async recordDisconnect(): Promise<void> {
    await this.withFileLock(async () => {
      await this.update((telemetry) => ({
        ...telemetry,
        lastDisconnectAt: new Date().toISOString(),
        lastKnownConnected: false,
        lastKnownAuthMode: null
      }));
    });
  }

  async recordStatusSnapshot(status: CodexAuthStatus): Promise<void> {
    await this.withFileLock(async () => {
      await this.update((telemetry) => ({
        ...telemetry,
        lastStatusCheckedAt: new Date().toISOString(),
        lastKnownConnected: status.connected,
        lastKnownAuthMode: status.authMode,
        lastStatusError: null
      }));
    });
  }

  async recordStatusError(message: string): Promise<void> {
    await this.withFileLock(async () => {
      await this.update((telemetry) => ({
        ...telemetry,
        lastStatusCheckedAt: new Date().toISOString(),
        lastStatusError: {
          message,
          at: new Date().toISOString()
        }
      }));
    });
  }

  private async update(updater: (telemetry: CodexAuthTelemetry) => CodexAuthTelemetry): Promise<void> {
    const state = await this.read();
    state.telemetry = updater(state.telemetry);
    await this.write(state);
  }

  private async read(): Promise<AuthStateFile> {
    await this.ensureReady();
    const raw = await fs.readFile(this.filePath, "utf8");
    let parsed: Partial<AuthStateFile>;
    try {
      parsed = JSON.parse(raw) as Partial<AuthStateFile>;
    } catch {
      return { telemetry: { ...DEFAULT_TELEMETRY } };
    }
    if (!parsed || typeof parsed !== "object") {
      return { telemetry: { ...DEFAULT_TELEMETRY } };
    }

    const telemetry = parsed.telemetry;
    if (!telemetry || typeof telemetry !== "object") {
      return { telemetry: { ...DEFAULT_TELEMETRY } };
    }

    return {
      telemetry: {
        ...DEFAULT_TELEMETRY,
        ...telemetry
      }
    };
  }

  private async write(state: AuthStateFile): Promise<void> {
    const temp = `${this.filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.ioQueue.then(operation, operation);
    this.ioQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
