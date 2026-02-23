export type ParsedCommand =
  | { kind: "remind_add"; remindAt: string; text: string }
  | { kind: "remind_list" }
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
  | { kind: "side_effect_send"; text: string }
  | { kind: "approve"; token: string };

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

  if (value.toLowerCase().startsWith("send ")) {
    return { kind: "side_effect_send", text: value.slice(5).trim() };
  }

  if (value.toLowerCase().startsWith("approve ")) {
    const token = value.slice(8).trim();
    if (token) {
      return { kind: "approve", token };
    }
  }

  return null;
}
