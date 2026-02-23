import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAuthService } from "../../apps/gateway-orchestrator/src/codex/auth_service";
import { CodexThreadStore } from "../../apps/gateway-orchestrator/src/codex/thread_store";
import { CodexChatService } from "../../apps/gateway-orchestrator/src/llm/codex_chat_service";

describe("CodexChatService", () => {
  it("returns agent text from item/turn completion notifications", async () => {
    const listeners = new Set<(event: { method: string; params: unknown }) => void>();

    const fakeClient = {
      ensureStarted: async () => undefined,
      onNotification: (listener: (event: { method: string; params: unknown }) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      request: async (method: string) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" } };
        }
        if (method === "turn/start") {
          setTimeout(() => {
            for (const listener of listeners) {
              listener({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "agentMessage",
                    text: "hello from codex"
                  }
                }
              });
            }

            for (const listener of listeners) {
              listener({
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: {
                    id: "turn-1",
                    status: "completed"
                  }
                }
              });
            }
          }, 10);

          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method ${method}`);
      }
    } as const;

    const fakeAuth = {
      readStatus: async () => ({
        connected: true,
        authMode: "chatgpt" as const,
        requiresOpenaiAuth: true
      })
    } as unknown as CodexAuthService;

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-codex-chat-unit-"));
    const threadStore = new CodexThreadStore(stateDir);
    const service = new CodexChatService({
      client: fakeClient as never,
      auth: fakeAuth,
      threadStore,
      timeoutMs: 2000
    });

    const result = await service.generateText("owner@s.whatsapp.net", "hello");
    expect(result?.text).toBe("hello from codex");
    expect(result?.authMode).toBe("oauth");
  });

  it("returns null when codex auth is not connected", async () => {
    const fakeClient = {
      ensureStarted: async () => undefined,
      onNotification: () => () => undefined,
      request: async () => ({})
    } as const;

    const fakeAuth = {
      readStatus: async () => ({
        connected: false,
        authMode: null,
        requiresOpenaiAuth: true
      })
    } as unknown as CodexAuthService;

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-codex-chat-unit-null-"));
    const threadStore = new CodexThreadStore(stateDir);
    const service = new CodexChatService({
      client: fakeClient as never,
      auth: fakeAuth,
      threadStore
    });

    const result = await service.generateText("owner@s.whatsapp.net", "hello");
    expect(result).toBeNull();
  });
});
