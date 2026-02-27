import { describe, expect, it, vi } from "vitest";
import { ensureWorkerCodexRuntime } from "../../apps/worker/src/runtime/codex_runtime";

describe("ensureWorkerCodexRuntime", () => {
  it("returns runtime unchanged when no auth handle exists", async () => {
    const runtime = await ensureWorkerCodexRuntime<{ ensureReady: () => Promise<void>; stop: () => Promise<void> }, string>({
      auth: undefined,
      chat: "chat-runtime"
    });
    expect(runtime.auth).toBeUndefined();
    expect(runtime.chat).toBe("chat-runtime");
  });

  it("keeps auth/chat when ensureReady succeeds", async () => {
    const ensureReady = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const auth = { ensureReady, stop };
    const runtime = await ensureWorkerCodexRuntime({
      auth,
      chat: "chat-runtime"
    });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(runtime.auth).toBe(auth);
    expect(runtime.chat).toBe("chat-runtime");
  });

  it("drops auth/chat and stops auth when ensureReady throws", async () => {
    const ensureReady = vi.fn(async () => {
      throw new Error("boot-failed");
    });
    const stop = vi.fn(async () => {});
    const runtime = await ensureWorkerCodexRuntime({
      auth: { ensureReady, stop },
      chat: "chat-runtime"
    });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.auth).toBeUndefined();
    expect(runtime.chat).toBeUndefined();
  });
});
