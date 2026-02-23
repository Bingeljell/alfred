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

  it("retries with a fresh thread when persisted thread id is stale", async () => {
    const listeners = new Set<(event: { method: string; params: unknown }) => void>();
    let threadStartCount = 0;
    let turnStartCount = 0;

    const fakeClient = {
      ensureStarted: async () => undefined,
      onNotification: (listener: (event: { method: string; params: unknown }) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      request: async (method: string, params?: { threadId?: string }) => {
        if (method === "thread/start") {
          threadStartCount += 1;
          return { thread: { id: `thread-fresh-${threadStartCount}` } };
        }

        if (method === "turn/start") {
          turnStartCount += 1;
          if (turnStartCount === 1) {
            expect(params?.threadId).toBe("thread-stale");
            throw new Error("thread_not_found");
          }

          const activeThreadId = params?.threadId ?? "thread-fresh-unknown";
          setTimeout(() => {
            for (const listener of listeners) {
              listener({
                method: "item/completed",
                params: {
                  threadId: activeThreadId,
                  turnId: "turn-2",
                  item: {
                    type: "agentMessage",
                    text: "recovered reply"
                  }
                }
              });
            }

            for (const listener of listeners) {
              listener({
                method: "turn/completed",
                params: {
                  threadId: activeThreadId,
                  turn: {
                    id: "turn-2",
                    status: "completed"
                  }
                }
              });
            }
          }, 10);

          return { turn: { id: "turn-2" } };
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

    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-codex-chat-unit-retry-"));
    const threadStore = new CodexThreadStore(stateDir);
    await threadStore.put("owner@s.whatsapp.net", "thread-stale");

    const service = new CodexChatService({
      client: fakeClient as never,
      auth: fakeAuth,
      threadStore,
      timeoutMs: 2000
    });

    const result = await service.generateText("owner@s.whatsapp.net", "hello after restart");
    expect(result?.text).toBe("recovered reply");
    expect(threadStartCount).toBe(1);
    expect(turnStartCount).toBe(2);
    expect(await threadStore.get("owner@s.whatsapp.net")).toBe("thread-fresh-1");
  });
});
