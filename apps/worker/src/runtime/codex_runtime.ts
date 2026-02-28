export type WorkerCodexAuthHandle = {
  ensureReady: () => Promise<void>;
  stop: () => Promise<void>;
};

export type WorkerCodexRuntime<TAuth extends WorkerCodexAuthHandle, TChat> = {
  auth?: TAuth;
  chat?: TChat;
};

export async function ensureWorkerCodexRuntime<TAuth extends WorkerCodexAuthHandle, TChat>(
  runtime: WorkerCodexRuntime<TAuth, TChat>
): Promise<WorkerCodexRuntime<TAuth, TChat>> {
  if (!runtime.auth) {
    return runtime;
  }

  try {
    await runtime.auth.ensureReady();
    return runtime;
  } catch {
    await runtime.auth.stop();
    return {
      auth: undefined,
      chat: undefined
    };
  }
}
