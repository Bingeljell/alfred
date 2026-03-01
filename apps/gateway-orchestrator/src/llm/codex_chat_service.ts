import { CodexAuthService } from "../codex/auth_service";
import { CodexAppServerClient } from "../codex/app_server_client";
import { CodexThreadStore } from "../codex/thread_store";
import type { LlmExecutionMode } from "../orchestrator/types";

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
  errorMessage?: string;
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

  async generateText(
    sessionId: string,
    input: string,
    options?: { executionMode?: LlmExecutionMode }
  ): Promise<{ text: string; model: string; authMode: "oauth" } | null> {
    await this.client.ensureStarted();
    await this.threadStore.ensureReady();
    const executionMode = options?.executionMode ?? "default";
    const turnInput = this.buildTurnInput(input, executionMode);

    const status = await this.auth.readStatus(this.accountRefreshBeforeTurn);
    if (!status.connected || status.authMode !== "chatgpt") {
      return null;
    }

    let threadId = await this.resolveThreadId(sessionId);
    let started: TurnStartResponse;
    try {
      started = await this.client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: turnInput,
            text_elements: []
          }
        ]
      });
    } catch (error) {
      // Thread IDs may become stale across process restarts; retry once with a fresh thread.
      const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const isThreadError = detail.includes("thread");
      if (!isThreadError) {
        throw error;
      }

      await this.threadStore.delete(sessionId);
      threadId = await this.resolveThreadId(sessionId);
      started = await this.client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: turnInput,
            text_elements: []
          }
        ]
      });
    }

    const completion = await this.waitForTurnCompletion(threadId, started.turn.id);
    if (completion.status !== "completed") {
      const detail = completion.errorMessage?.trim();
      if (detail) {
        throw new Error(`codex_turn_${completion.status}:${detail}`);
      }
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

  private buildTurnInput(input: string, executionMode: LlmExecutionMode): string {
    const trimmedInput = input.trim();
    if (executionMode !== "reasoning_only") {
      return trimmedInput;
    }

    const guardrail = [
      "[EXECUTION_MODE=REASONING_ONLY]",
      "You are in analysis mode only.",
      "Do not execute commands, edit files, call tools, or perform side effects.",
      "If a side effect is requested, propose the next action and ask for explicit approval."
    ].join("\n");

    return `${guardrail}\n\n${trimmedInput}`;
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
            item?: { type?: string; text?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (params.threadId !== threadId || params.turnId !== turnId) {
            return;
          }
          const next = extractAssistantItemText(params.item);
          if (next) {
            capturedText += next;
          }
          return;
        }

        if (event.method !== "turn/completed") {
          return;
        }

        const params = (event.params ?? {}) as {
          threadId?: string;
          turn?: {
            id?: string;
            status?: TurnCompletion["status"];
            error?: { message?: string };
            items?: Array<{ type?: string; text?: string; content?: Array<{ type?: string; text?: string }> }>;
          };
        };
        if (params.threadId !== threadId || params.turn?.id !== turnId) {
          return;
        }

        if (!capturedText && Array.isArray(params.turn?.items)) {
          for (const item of params.turn.items) {
            const text = extractAssistantItemText(item);
            if (text) {
              capturedText += text;
            }
          }
        }

        clearTimeout(timer);
        unsubscribe();
        resolve({
          threadId,
          turnId,
          status: params.turn?.status ?? "failed",
          text: capturedText,
          errorMessage: params.turn?.error?.message
        });
      });
    });
  }
}

function extractAssistantItemText(item?: {
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (!item || typeof item !== "object") {
    return "";
  }

  const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
  if (itemType !== "assistantmessage" && itemType !== "agentmessage") {
    return "";
  }

  const directText = typeof item.text === "string" ? item.text.trim() : "";
  if (directText) {
    return directText;
  }

  if (!Array.isArray(item.content)) {
    return "";
  }

  const parts: string[] = [];
  for (const entry of item.content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const entryType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
    if (entryType !== "text" && entryType !== "output_text") {
      continue;
    }
    const value = typeof entry.text === "string" ? entry.text.trim() : "";
    if (value) {
      parts.push(value);
    }
  }

  return parts.join("\n");
}
