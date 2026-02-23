import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AppServerNotification = {
  method: string;
  params: unknown;
};

export type ChatgptTokensRefreshResponse = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
};

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private listeners = new Set<(event: AppServerNotification) => void>();
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private started = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly clientName: string;
  private readonly clientVersion: string;

  private refreshHandler?: (reason: string, previousAccountId?: string | null) => Promise<ChatgptTokensRefreshResponse | null>;

  constructor(options?: {
    command?: string;
    args?: string[];
    cwd?: string;
    clientName?: string;
    clientVersion?: string;
  }) {
    this.command = options?.command ?? "codex";
    this.args = options?.args ?? ["app-server", "--listen", "stdio://"];
    this.cwd = options?.cwd;
    this.clientName = options?.clientName ?? "alfred-gateway";
    this.clientVersion = options?.clientVersion ?? "0.1.0";
  }

  async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) {
      throw new Error("codex_app_server_not_running");
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  onNotification(listener: (event: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setChatgptAuthTokensRefreshHandler(
    handler: (reason: string, previousAccountId?: string | null) => Promise<ChatgptTokensRefreshResponse | null>
  ): void {
    this.refreshHandler = handler;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    this.started = false;

    for (const [, request] of this.pending) {
      request.reject(new Error("codex_app_server_stopped"));
    }
    this.pending.clear();

    child.kill("SIGTERM");
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child = child;

    child.on("error", (error) => {
      this.handleFatal(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("exit", () => {
      this.handleFatal(new Error("codex_app_server_exited"));
    });

    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on("line", () => {
      // Intentionally ignored to avoid leaking auth/token material into logs.
    });

    const stdoutRl = readline.createInterface({ input: child.stdout });
    stdoutRl.on("line", (line) => {
      this.handleLine(line);
    });

    await this.requestInternal("initialize", {
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion
      },
      capabilities: {
        experimentalApi: true
      }
    });

    const initialized: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "initialized"
    };
    child.stdin.write(`${JSON.stringify(initialized)}\n`);
    this.started = true;
  }

  private async requestInternal<T>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error("codex_app_server_not_running");
    }

    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const hasMethod = typeof message.method === "string";
    const hasId = typeof message.id === "string" || typeof message.id === "number";

    if (hasMethod && hasId) {
      void this.handleServerRequest({
        jsonrpc: "2.0",
        id: message.id as JsonRpcId,
        method: message.method as string,
        params: message.params
      });
      return;
    }

    if (hasMethod) {
      const event: AppServerNotification = {
        method: message.method as string,
        params: message.params
      };
      for (const listener of this.listeners) {
        listener(event);
      }
      return;
    }

    if (hasId) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "codex_jsonrpc_error"));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    if (request.method === "account/chatgptAuthTokens/refresh") {
      const params = (request.params ?? {}) as { reason?: string; previousAccountId?: string | null };
      try {
        if (!this.refreshHandler) {
          throw new Error("chatgpt_auth_tokens_refresh_not_configured");
        }

        const refreshed = await this.refreshHandler(params.reason ?? "unknown", params.previousAccountId ?? null);
        if (!refreshed) {
          throw new Error("chatgpt_auth_tokens_refresh_unavailable");
        }

        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id,
          result: refreshed
        };
        child.stdin.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        };
        child.stdin.write(`${JSON.stringify(response)}\n`);
      }
      return;
    }

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `unsupported_server_request:${request.method}`
      }
    };
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleFatal(error: Error): void {
    if (!this.child) {
      return;
    }

    this.child = null;
    this.started = false;

    for (const [, request] of this.pending) {
      request.reject(error);
    }
    this.pending.clear();
  }
}
