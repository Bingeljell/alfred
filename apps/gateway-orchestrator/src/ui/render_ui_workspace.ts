import { renderUiHeader } from "./shared_shell";

export function renderUiWorkspaceHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alfred Workspace</title>
    <style>
      :root {
        --bg: #f4f0e8;
        --panel: #fffdf8;
        --line: #d8d2c5;
        --ink: #171717;
        --muted: #5f5a50;
        --accent: #0f766e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(1100px 500px at 100% -10%, #dff0ea 0%, transparent 60%),
          radial-gradient(800px 450px at -10% 110%, #efe4d0 0%, transparent 60%),
          var(--bg);
      }
      .workspace {
        display: grid;
        grid-template-columns: 300px minmax(420px, 1fr) 360px;
        gap: 12px;
        padding: 12px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
        min-height: 74vh;
        min-width: 0;
      }
      h2 {
        margin: 0 0 8px;
        font-size: 14px;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
      .list {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        overflow: auto;
        max-height: 30vh;
      }
      .list button {
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        border-bottom: 1px solid #eee6d8;
        padding: 8px;
        cursor: pointer;
        font: inherit;
      }
      .list button[aria-current="true"] {
        background: #e9f8f5;
      }
      .name {
        font-size: 12px;
        font-weight: 700;
      }
      .meta {
        font-size: 11px;
        color: var(--muted);
        margin-top: 2px;
      }
      .chat-log, .event-log {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #15171b;
        color: #d5f7dc;
        padding: 10px;
        min-height: 50vh;
        max-height: 62vh;
        overflow: auto;
        white-space: pre-wrap;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
      }
      .composer {
        margin-top: 10px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      textarea {
        min-height: 70px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px;
        font: inherit;
        resize: vertical;
      }
      button {
        border: 1px solid color-mix(in oklab, var(--accent) 40%, white 60%);
        background: #dbf3ef;
        color: #0f3f3a;
        border-radius: 8px;
        padding: 8px 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .secondary {
        background: #f7f7f7;
        border-color: var(--line);
        color: #2f2f2f;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      input {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 6px 8px;
        font: inherit;
      }
      .pill {
        display: inline-block;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 4px 7px;
        font-size: 11px;
        background: #fff;
        margin: 2px 4px 2px 0;
      }
      .artifact {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        padding: 8px;
        margin-bottom: 6px;
      }
      .artifact a {
        color: #0f4b45;
      }
      @media (max-width: 1300px) {
        .workspace { grid-template-columns: 1fr; }
        .panel { min-height: auto; }
        .chat-log, .event-log, .list { max-height: 45vh; }
      }
    </style>
  </head>
  <body>
    ${renderUiHeader({
      title: "Alfred Workspace",
      subtitle: "Session control, agent chat, runs, approvals, and artifacts.",
      current: "workspace"
    })}
    <main class="workspace">
      <section class="panel">
        <h2>Sessions</h2>
        <div class="row">
          <label class="muted" for="sessionInput">Session</label>
          <input id="sessionInput" value="owner@s.whatsapp.net" />
          <button class="secondary" id="refreshSessions">Refresh</button>
        </div>
        <div id="sessionList" class="list"></div>
        <h2 style="margin-top:12px;">Runs</h2>
        <div class="row">
          <button class="secondary" id="refreshRuns">Refresh Runs</button>
        </div>
        <div id="runList" class="list"></div>
      </section>
      <section class="panel">
        <h2>Chat</h2>
        <div class="row">
          <span class="pill" id="activeSessionPill">session: owner@s.whatsapp.net</span>
          <button class="secondary" id="refreshChat">Refresh Chat</button>
          <button class="secondary" id="toggleAuto">Auto: On</button>
        </div>
        <pre id="chatLog" class="chat-log"></pre>
        <div class="composer">
          <textarea id="chatInput" placeholder="Ask Alfred..."></textarea>
          <button id="sendBtn">Send</button>
        </div>
      </section>
      <section class="panel">
        <h2>Tool Trace + Approvals</h2>
        <div class="row">
          <span class="pill" id="activeRunPill">run: none</span>
          <button class="secondary" id="refreshRight">Refresh</button>
        </div>
        <h2 style="margin-top:0;">Execution Stream</h2>
        <pre id="execLog" class="event-log"></pre>
        <h2 style="margin-top:12px;">Run Trace</h2>
        <pre id="eventLog" class="event-log"></pre>
        <h2 style="margin-top:12px;">Pending Approvals</h2>
        <div id="approvals"></div>
        <h2 style="margin-top:12px;">Artifacts</h2>
        <div id="artifacts"></div>
      </section>
    </main>
    <script>
      const $ = (id) => document.getElementById(id);
      let activeSessionId = $("sessionInput").value.trim();
      let activeRunId = "";
      let autoEnabled = true;
      let pollTimer = null;

      async function api(method, url, body) {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined
        });
        let data = null;
        try { data = await res.json(); } catch { data = { raw: await res.text() }; }
        return { ok: res.ok, status: res.status, data };
      }

      function setActiveSession(sessionId) {
        activeSessionId = sessionId;
        $("sessionInput").value = sessionId;
        $("activeSessionPill").textContent = "session: " + sessionId;
      }

      function setActiveRun(runId) {
        activeRunId = runId || "";
        $("activeRunPill").textContent = "run: " + (activeRunId || "none");
      }

      async function loadSessions() {
        const response = await api("GET", "/v1/agent/sessions?limit=120");
        const host = $("sessionList");
        if (!response.ok) {
          host.innerHTML = "<div class='meta' style='padding:8px;'>Unable to load sessions</div>";
          return;
        }
        const sessions = Array.isArray(response.data?.sessions) ? response.data.sessions : [];
        host.innerHTML = "";
        sessions.forEach((item) => {
          const button = document.createElement("button");
          button.setAttribute("type", "button");
          const sid = String(item.sessionId || "unknown");
          button.setAttribute("aria-current", String(sid === activeSessionId));
          button.innerHTML =
            "<div class='name'>" + sid + "</div>" +
            "<div class='meta'>" + String(item.lastAt || "") + " • " + String(item.lastKind || "") + "</div>" +
            "<div class='meta'>" + String(item.preview || "").slice(0, 120) + "</div>";
          button.addEventListener("click", () => {
            setActiveSession(sid);
            void refreshAll();
          });
          host.appendChild(button);
        });
      }

      async function loadRuns() {
        if (!activeSessionId) {
          $("runList").innerHTML = "";
          setActiveRun("");
          return;
        }
        const response = await api("GET", "/v1/agent/runs?sessionId=" + encodeURIComponent(activeSessionId) + "&limit=80");
        const host = $("runList");
        if (!response.ok) {
          host.innerHTML = "<div class='meta' style='padding:8px;'>Unable to load runs</div>";
          return;
        }
        const runs = Array.isArray(response.data?.runs) ? response.data.runs : [];
        if (runs.length === 0) {
          setActiveRun("");
        } else {
          const hasCurrent = runs.some((run) => String(run.runId || "") === activeRunId);
          if (!hasCurrent) {
            setActiveRun(String(runs[0]?.runId || ""));
          }
        }
        host.innerHTML = "";
        runs.forEach((run) => {
          const runId = String(run.runId || "");
          const button = document.createElement("button");
          button.setAttribute("type", "button");
          button.setAttribute("aria-current", String(runId === activeRunId));
          button.innerHTML =
            "<div class='name'>" + runId.slice(0, 12) + " • " + String(run.status || "unknown") + "</div>" +
            "<div class='meta'>" + String(run.currentPhase || "") + " • " + String(run.createdAt || "") + "</div>";
          button.addEventListener("click", () => {
            setActiveRun(runId);
            void refreshRightPane();
          });
          host.appendChild(button);
        });
      }

      async function loadChat() {
        if (!activeSessionId) {
          return;
        }
        const response = await api(
          "GET",
          "/v1/stream/events?sessionId=" + encodeURIComponent(activeSessionId) + "&kinds=chat&limit=300&noisy=true"
        );
        if (!response.ok) {
          $("chatLog").textContent = "Unable to load chat transcript.";
          return;
        }
        const events = Array.isArray(response.data?.events) ? response.data.events : [];
        const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const lines = sorted.map((event) => {
          const at = String(event.createdAt || "").slice(11, 19) || "??:??:??";
          const direction = event.direction === "outbound" ? "assistant" : event.direction === "inbound" ? "user" : "system";
          const text = String(event.text || "").replace(/\\s+/g, " ").trim();
          return "[" + at + "] " + direction + ": " + text;
        });
        $("chatLog").textContent = lines.join("\\n");
      }

      async function loadExecutionStream() {
        if (!activeSessionId) {
          $("execLog").textContent = "Select a session to view execution stream.";
          return;
        }
        const response = await api(
          "GET",
          "/v1/stream/events?sessionId=" + encodeURIComponent(activeSessionId) + "&kinds=command,job,error,status&limit=400&noisy=true"
        );
        if (!response.ok) {
          $("execLog").textContent = "Unable to load execution stream.";
          return;
        }
        const events = Array.isArray(response.data?.events) ? response.data.events : [];
        const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const lines = sorted.map((event) => {
          const at = String(event.createdAt || "").slice(11, 19) || "??:??:??";
          const source = String(event.source || "system");
          const kind = String(event.kind || "event");
          const text = String(event.text || "").replace(/\\s+/g, " ").trim();
          return "[" + at + "] " + source + "/" + kind + ": " + text;
        });
        $("execLog").textContent = lines.join("\\n") || "No execution events yet.";
      }

      async function loadRunEvents() {
        if (!activeRunId) {
          $("eventLog").textContent = "Select a run to view tool trace.";
          return;
        }
        const response = await api("GET", "/v1/agent/runs/" + encodeURIComponent(activeRunId) + "/events?limit=400");
        if (!response.ok) {
          $("eventLog").textContent = "Unable to load run events.";
          return;
        }
        const events = Array.isArray(response.data?.events) ? response.data.events : [];
        const lines = events.map((event) => {
          const at = String(event.createdAt || "").slice(11, 19) || "??:??:??";
          const text = String(event.text || "").replace(/\\s+/g, " ").trim();
          return "[" + at + "] " + String(event.kind || "event") + ": " + text;
        });
        $("eventLog").textContent = lines.join("\\n");
      }

      async function loadApprovals() {
        const host = $("approvals");
        if (!activeSessionId) {
          host.innerHTML = "";
          return;
        }
        const response = await api("GET", "/v1/approvals/pending?sessionId=" + encodeURIComponent(activeSessionId) + "&limit=20");
        if (!response.ok) {
          host.innerHTML = "<div class='meta'>Unable to load approvals.</div>";
          return;
        }
        const pending = Array.isArray(response.data?.pending) ? response.data.pending : [];
        if (pending.length === 0) {
          host.innerHTML = "<div class='meta'>No pending approvals.</div>";
          return;
        }
        host.innerHTML = "";
        pending.forEach((item) => {
          const container = document.createElement("div");
          container.className = "artifact";
          const token = String(item.token || "");
          const action = String(item.action || "action");
          container.innerHTML =
            "<div class='name'>" + action + "</div>" +
            "<div class='meta'>token: " + token + "</div>" +
            "<div class='row' style='margin-top:8px;'>" +
            "<button type='button' data-decision='approve'>Approve</button>" +
            "<button type='button' data-decision='reject' class='secondary'>Reject</button>" +
            "</div>";
          container.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", async () => {
              const decision = button.getAttribute("data-decision");
              await api("POST", "/v1/approvals/resolve", {
                sessionId: activeSessionId,
                decision,
                token
              });
              await refreshAll();
            });
          });
          host.appendChild(container);
        });
      }

      async function loadArtifacts() {
        const host = $("artifacts");
        if (!activeRunId) {
          host.innerHTML = "<div class='meta'>No active run selected.</div>";
          return;
        }
        const response = await api("GET", "/v1/agent/runs/" + encodeURIComponent(activeRunId) + "/artifacts");
        if (!response.ok) {
          host.innerHTML = "<div class='meta'>Unable to load artifacts.</div>";
          return;
        }
        const artifacts = Array.isArray(response.data?.artifacts) ? response.data.artifacts : [];
        if (artifacts.length === 0) {
          host.innerHTML = "<div class='meta'>No artifacts recorded for this run yet.</div>";
          return;
        }
        host.innerHTML = "";
        artifacts.forEach((item) => {
          const card = document.createElement("div");
          card.className = "artifact";
          const path = String(item.path || "");
          const name = String(item.name || path || "artifact");
          card.innerHTML =
            "<div class='name'>" + name + "</div>" +
            "<div class='meta'>" + path + "</div>";
          host.appendChild(card);
        });
      }

      async function sendChat() {
        const text = $("chatInput").value.trim();
        if (!text || !activeSessionId) {
          return;
        }
        $("chatInput").value = "";
        await api("POST", "/v1/messages/inbound", {
          sessionId: activeSessionId,
          text,
          requestJob: false
        });
        await refreshAll();
      }

      async function refreshRightPane() {
        await Promise.all([loadExecutionStream(), loadRunEvents(), loadApprovals(), loadArtifacts()]);
      }

      async function refreshAll() {
        await Promise.all([loadSessions(), loadRuns(), loadChat()]);
        await refreshRightPane();
      }

      function startPoller() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (!autoEnabled) {
          return;
        }
        pollTimer = setInterval(() => {
          void refreshAll();
        }, 5000);
      }

      $("refreshSessions").addEventListener("click", () => { void refreshAll(); });
      $("refreshRuns").addEventListener("click", () => { void loadRuns(); });
      $("refreshChat").addEventListener("click", () => { void loadChat(); });
      $("refreshRight").addEventListener("click", () => { void refreshRightPane(); });
      $("sendBtn").addEventListener("click", () => { void sendChat(); });
      $("sessionInput").addEventListener("change", () => {
        setActiveSession($("sessionInput").value.trim() || "owner@s.whatsapp.net");
        void refreshAll();
      });
      $("chatInput").addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void sendChat();
        }
      });
      $("toggleAuto").addEventListener("click", () => {
        autoEnabled = !autoEnabled;
        $("toggleAuto").textContent = "Auto: " + (autoEnabled ? "On" : "Off");
        startPoller();
      });

      void refreshAll();
      startPoller();
    </script>
  </body>
</html>`;
}
