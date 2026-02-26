export type ParsedCommand =
  | { kind: "remind_add"; remindAt: string; text: string }
  | { kind: "remind_list" }
  | { kind: "calendar_add"; startsAt: string; title: string }
  | { kind: "calendar_list" }
  | { kind: "calendar_cancel"; id: string }
  | { kind: "note_add"; text: string }
  | { kind: "note_list" }
  | { kind: "task_add"; text: string }
  | { kind: "task_list" }
  | { kind: "task_done"; id: string }
  | { kind: "job_status"; id: string }
  | { kind: "job_cancel"; id: string }
  | { kind: "job_retry"; id: string }
  | { kind: "auth_connect" }
  | { kind: "auth_status" }
  | { kind: "auth_limits" }
  | { kind: "auth_disconnect" }
  | { kind: "web_search"; query: string; provider?: "searxng" | "openai" | "brave" | "perplexity" | "brightdata" }
  | {
      kind: "supervise_web";
      query: string;
      providers?: Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata">;
      maxRetries?: number;
      timeBudgetMs?: number;
      tokenBudget?: number;
    }
  | { kind: "supervisor_status"; id: string }
  | { kind: "file_write"; relativePath: string; text: string }
  | { kind: "file_send"; relativePath: string; caption?: string }
  | { kind: "policy_status" }
  | { kind: "approval_pending" }
  | { kind: "side_effect_send"; text: string }
  | { kind: "approve"; token: string }
  | { kind: "reject"; token: string };

export function parseCommand(text: string): ParsedCommand | null {
  const value = text.trim();
  if (!value) {
    return null;
  }

  if (value.toLowerCase() === "/remind list") {
    return { kind: "remind_list" };
  }

  if (value.toLowerCase().startsWith("/remind ")) {
    const parts = value.split(" ");
    if (parts.length >= 3) {
      const remindAt = parts[1];
      const note = parts.slice(2).join(" ").trim();
      if (note) {
        return { kind: "remind_add", remindAt, text: note };
      }
    }
  }

  if (value.toLowerCase() === "/calendar list") {
    return { kind: "calendar_list" };
  }

  if (value.toLowerCase().startsWith("/calendar add ")) {
    const parts = value.split(" ");
    if (parts.length >= 4) {
      const startsAt = parts[2];
      const title = parts.slice(3).join(" ").trim();
      if (title) {
        return { kind: "calendar_add", startsAt, title };
      }
    }
  }

  if (value.toLowerCase().startsWith("/calendar cancel ")) {
    const id = value.slice("/calendar cancel ".length).trim();
    if (id) {
      return { kind: "calendar_cancel", id };
    }
  }

  if (value.toLowerCase().startsWith("/task add ")) {
    const note = value.slice("/task add ".length).trim();
    if (note) {
      return { kind: "task_add", text: note };
    }
  }

  if (value.toLowerCase().startsWith("/note add ")) {
    const note = value.slice("/note add ".length).trim();
    if (note) {
      return { kind: "note_add", text: note };
    }
  }

  if (value.toLowerCase() === "/note list") {
    return { kind: "note_list" };
  }

  if (value.toLowerCase() === "/task list") {
    return { kind: "task_list" };
  }

  if (value.toLowerCase().startsWith("/task done ")) {
    const id = value.slice("/task done ".length).trim();
    if (id) {
      return { kind: "task_done", id };
    }
  }

  if (value.toLowerCase().startsWith("/job status ")) {
    const id = value.slice("/job status ".length).trim();
    if (id) {
      return { kind: "job_status", id };
    }
  }

  if (value.toLowerCase().startsWith("/job cancel ")) {
    const id = value.slice("/job cancel ".length).trim();
    if (id) {
      return { kind: "job_cancel", id };
    }
  }

  if (value.toLowerCase().startsWith("/job retry ")) {
    const id = value.slice("/job retry ".length).trim();
    if (id) {
      return { kind: "job_retry", id };
    }
  }

  if (value.toLowerCase() === "/auth connect") {
    return { kind: "auth_connect" };
  }

  if (value.toLowerCase() === "/auth status") {
    return { kind: "auth_status" };
  }

  if (value.toLowerCase() === "/auth limits") {
    return { kind: "auth_limits" };
  }

  if (value.toLowerCase() === "/auth disconnect") {
    return { kind: "auth_disconnect" };
  }

  if (value.toLowerCase() === "/policy") {
    return { kind: "policy_status" };
  }

  if (value.toLowerCase() === "/approval" || value.toLowerCase() === "/approval pending") {
    return { kind: "approval_pending" };
  }

  if (value.toLowerCase().startsWith("/web ")) {
    const payload = value.slice("/web ".length).trim();
    const providerMatch = payload.match(/^--provider=(searxng|openai|brave|perplexity|brightdata)\s+/i);
    const provider = providerMatch?.[1]?.toLowerCase() as
      | "searxng"
      | "openai"
      | "brave"
      | "perplexity"
      | "brightdata"
      | undefined;
    const query = provider ? payload.slice(providerMatch?.[0]?.length ?? 0).trim() : payload;
    if (query) {
      return { kind: "web_search", query, provider };
    }
  }

  if (value.toLowerCase().startsWith("/supervise web ")) {
    const payload = value.slice("/supervise web ".length).trim();
    const tokens = payload.split(/\s+/);
    const providers: Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata"> = [];
    let maxRetries: number | undefined;
    let timeBudgetMs: number | undefined;
    let tokenBudget: number | undefined;
    let index = 0;

    while (index < tokens.length && tokens[index]?.startsWith("--")) {
      const token = tokens[index] ?? "";
      index += 1;
      if (token.startsWith("--providers=")) {
        const values = token
          .slice("--providers=".length)
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(
            (item) => item === "searxng" || item === "openai" || item === "brave" || item === "perplexity" || item === "brightdata"
          ) as Array<"searxng" | "openai" | "brave" | "perplexity" | "brightdata">;
        for (const provider of values) {
          if (!providers.includes(provider)) {
            providers.push(provider);
          }
        }
        continue;
      }
      if (token.startsWith("--max-retries=")) {
        const parsed = Number(token.slice("--max-retries=".length));
        if (Number.isFinite(parsed)) {
          maxRetries = Math.max(0, Math.min(5, Math.floor(parsed)));
        }
        continue;
      }
      if (token.startsWith("--time-budget-ms=")) {
        const parsed = Number(token.slice("--time-budget-ms=".length));
        if (Number.isFinite(parsed)) {
          timeBudgetMs = Math.max(5000, Math.min(600000, Math.floor(parsed)));
        }
        continue;
      }
      if (token.startsWith("--token-budget=")) {
        const parsed = Number(token.slice("--token-budget=".length));
        if (Number.isFinite(parsed)) {
          tokenBudget = Math.max(128, Math.min(50000, Math.floor(parsed)));
        }
        continue;
      }
    }

    const query = tokens.slice(index).join(" ").trim();
    if (query) {
      return {
        kind: "supervise_web",
        query,
        providers: providers.length > 0 ? providers : undefined,
        maxRetries,
        timeBudgetMs,
        tokenBudget
      };
    }
  }

  if (value.toLowerCase().startsWith("/supervisor status ")) {
    const id = value.slice("/supervisor status ".length).trim();
    if (id) {
      return { kind: "supervisor_status", id };
    }
  }

  if (value.toLowerCase().startsWith("/write ")) {
    const payload = value.slice("/write ".length).trim();
    const firstSpace = payload.indexOf(" ");
    if (firstSpace > 0) {
      const relativePath = payload.slice(0, firstSpace).trim();
      const text = payload.slice(firstSpace + 1).trim();
      if (relativePath && text) {
        return { kind: "file_write", relativePath, text };
      }
    }
  }

  if (value.toLowerCase().startsWith("/file write ")) {
    const payload = value.slice("/file write ".length).trim();
    const firstSpace = payload.indexOf(" ");
    if (firstSpace > 0) {
      const relativePath = payload.slice(0, firstSpace).trim();
      const text = payload.slice(firstSpace + 1).trim();
      if (relativePath && text) {
        return { kind: "file_write", relativePath, text };
      }
    }
  }

  if (value.toLowerCase().startsWith("/file send ")) {
    const payload = value.slice("/file send ".length).trim();
    const firstSpace = payload.indexOf(" ");
    if (firstSpace > 0) {
      const relativePath = payload.slice(0, firstSpace).trim();
      const caption = payload.slice(firstSpace + 1).trim();
      if (relativePath) {
        return { kind: "file_send", relativePath, caption: caption || undefined };
      }
    } else if (payload) {
      return { kind: "file_send", relativePath: payload };
    }
  }

  if (value.toLowerCase().startsWith("send ")) {
    return { kind: "side_effect_send", text: value.slice(5).trim() };
  }

  if (value.toLowerCase().startsWith("approve ") || value.toLowerCase().startsWith("/approve ")) {
    const offset = value.toLowerCase().startsWith("/approve ") ? 9 : 8;
    const token = value.slice(offset).trim();
    if (token) {
      return { kind: "approve", token };
    }
  }

  if (value.toLowerCase().startsWith("reject ") || value.toLowerCase().startsWith("/reject ")) {
    const offset = value.toLowerCase().startsWith("/reject ") ? 8 : 7;
    const token = value.slice(offset).trim();
    if (token) {
      return { kind: "reject", token };
    }
  }

  return null;
}
