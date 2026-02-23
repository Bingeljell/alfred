import { CodexAuthService } from "../codex/auth_service";
import { CodexAppServerClient } from "../codex/app_server_client";
import { CodexThreadStore } from "../codex/thread_store";

type ThreadStartResponse = {
  thread: {
    id: string;
  };
};

type TurnStartResponse = {
  turn: {
    id: string;
  };
};

type TurnCompletion = {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  text?: string;
};

export class CodexChatService {
  private readonly client: CodexAppServerClient;
  private readonly auth: CodexAuthService;
  private readonly threadStore: CodexThreadStore;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly accountRefreshBeforeTurn: boolean;

  constructor(options: {
    client: CodexAppServerClient;
    auth: CodexAuthService;
    threadStore: CodexThreadStore;
    model?: string;
    timeoutMs?: number;
    accountRefreshBeforeTurn?: boolean;
  }) {
    this.client = options.client;
    this.auth = options.auth;
    this.threadStore = options.threadStore;
    this.model = options.model?.trim() ? options.model : undefined;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.accountRefreshBeforeTurn = options.accountRefreshBeforeTurn ?? true;
  }

  async generateText(sessionId: string, input: string): Promise<{ text: string; model: string; authMode: "oauth" } | null> {
    await this.client.ensureStarted();
    await this.threadStore.ensureReady();

    const status = await this.auth.readStatus(this.accountRefreshBeforeTurn);
    if (!status.connected || status.authMode !== "chatgpt") {
      return null;
    }

    const threadId = await this.resolveThreadId(sessionId);
    const started = await this.client.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: input,
          text_elements: []
        }
      ]
    });

    const completion = await this.waitForTurnCompletion(threadId, started.turn.id);
    if (completion.status !== "completed") {
      throw new Error(`codex_turn_${completion.status}`);
    }

    const text = completion.text?.trim();
    if (!text) {
      throw new Error("codex_turn_empty_text");
    }

    return {
      text,
      model: this.model ?? "openai-codex/default",
      authMode: "oauth"
    };
  }

  private async resolveThreadId(sessionId: string): Promise<string> {
    const existing = await this.threadStore.get(sessionId);
    if (existing) {
      return existing;
    }

    const started = await this.client.request<ThreadStartResponse>("thread/start", {
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      model: this.model ?? null
    });

    await this.threadStore.put(sessionId, started.thread.id);
    return started.thread.id;
  }

  private async waitForTurnCompletion(threadId: string, turnId: string): Promise<TurnCompletion> {
    return new Promise<TurnCompletion>((resolve, reject) => {
      let capturedText = "";
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("codex_turn_timeout"));
      }, this.timeoutMs);

      const unsubscribe = this.client.onNotification((event) => {
        if (event.method === "item/completed") {
          const params = (event.params ?? {}) as {
            threadId?: string;
            turnId?: string;
            item?: { type?: string; text?: string };
          };
          if (params.threadId !== threadId || params.turnId !== turnId) {
            return;
          }
          if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
            capturedText += params.item.text;
          }
          return;
        }

        if (event.method !== "turn/completed") {
          return;
        }

        const params = (event.params ?? {}) as {
          threadId?: string;
          turn?: { id?: string; status?: TurnCompletion["status"] };
        };
        if (params.threadId !== threadId || params.turn?.id !== turnId) {
          return;
        }

        clearTimeout(timer);
        unsubscribe();
        resolve({
          threadId,
          turnId,
          status: params.turn?.status ?? "failed",
          text: capturedText
        });
      });
    });
  }
}
