import { renderUiHeader } from "./shared_shell";

export function renderUiTranscriptsHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alfred Transcripts</title>
    <style>
      :root {
        --bg: #f5f1ea;
        --panel: #fffdf8;
        --ink: #1f1f1f;
        --muted: #5f5a50;
        --line: #dad2c1;
        --accent: #0f766e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(1000px 500px at 100% -10%, #dff0ea 0%, transparent 60%),
          radial-gradient(700px 400px at -10% 110%, #efe4d0 0%, transparent 60%),
          var(--bg);
      }
      header {
        padding: 18px 20px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in oklab, var(--panel) 90%, white 10%);
      }
      h1 { margin: 0; font-size: 22px; }
      .subtitle { margin-top: 6px; color: var(--muted); font-size: 13px; }
      .nav { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
      .nav a {
        text-decoration: none;
        border: 1px solid var(--line);
        background: #fff;
        color: #1f2937;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
      }
      .panel {
        margin: 14px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
      input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px;
        font: inherit;
        background: #fff;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      button {
        border: 1px solid color-mix(in oklab, var(--accent) 40%, white 60%);
        background: #dbf3ef;
        color: #0f3f3a;
        border-radius: 8px;
        padding: 7px 10px;
        font-weight: 600;
        cursor: pointer;
      }
      button.secondary { background: #f7f7f7; color: #303030; border-color: var(--line); }
      #transcript {
        width: 100%;
        min-height: 520px;
        max-height: 70vh;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #14161a;
        color: #d0f5da;
        padding: 10px;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #statusLine { margin-top: 8px; font-size: 12px; color: var(--muted); }
      #statusLine[data-state="error"] { color: #b42318; }
      #statusLine[data-state="success"] { color: #166534; }
      @media (max-width: 860px) {
        .row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    ${renderUiHeader({
      title: "Alfred Transcripts",
      subtitle: "Cross-source chat/command/job transcript viewer.",
      current: "transcripts"
    })}

    <section class="panel">
      <div class="row">
        <div>
          <label for="sessionId">Session ID</label>
          <input id="sessionId" value="owner@s.whatsapp.net" />
        </div>
        <div>
          <label for="transcriptDate">Day</label>
          <input type="date" id="transcriptDate" />
        </div>
        <div>
          <label for="allSessions">All Sessions</label>
          <input type="checkbox" id="allSessions" checked />
        </div>
      </div>
      <div class="actions">
        <button id="refreshBtn">Refresh</button>
        <button class="secondary" id="toggleAuto">Auto: On</button>
      </div>
      <div id="statusLine"></div>
      <pre id="transcript"></pre>
    </section>

    <script>
      const $ = (id) => document.getElementById(id);
      const transcriptNode = $("transcript");
      const statusLine = $("statusLine");
      let autoEnabled = true;
      let pollTimer = null;

      function localIsoDate(date) {
        const value = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return value.toISOString().slice(0, 10);
      }

      function setStatus(text, state) {
        statusLine.textContent = text;
        statusLine.dataset.state = state || "idle";
      }

      async function api(url) {
        const res = await fetch(url);
        let data = null;
        try { data = await res.json(); } catch { data = { raw: await res.text() }; }
        return { ok: res.ok, status: res.status, data };
      }

      function resolveDayBounds(rawDay) {
        if (!rawDay) {
          return null;
        }
        const day = rawDay.trim();
        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) {
          return null;
        }
        return {
          since: day + "T00:00:00.000Z",
          until: day + "T23:59:59.999Z"
        };
      }

      async function refreshTranscript() {
        const sessionId = $("sessionId").value.trim();
        const allSessions = $("allSessions").checked;
        const dayBounds = resolveDayBounds($("transcriptDate").value.trim());
        let url = "/v1/stream/events?kinds=chat,command,job&limit=500&noisy=true";
        if (!allSessions && sessionId) {
          url += "&sessionId=" + encodeURIComponent(sessionId);
        }
        if (dayBounds) {
          url += "&since=" + encodeURIComponent(dayBounds.since);
          url += "&until=" + encodeURIComponent(dayBounds.until);
        }
        const response = await api(url);
        if (!response.ok) {
          transcriptNode.textContent = "Unable to load transcript: HTTP " + response.status;
          setStatus("Transcript refresh failed (" + response.status + ")", "error");
          return;
        }

        const events = Array.isArray(response.data?.events) ? response.data.events : [];
        const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const lines = sorted.map((event) => {
          const at = typeof event.createdAt === "string" ? event.createdAt.slice(11, 19) : "??:??:??";
          const sid = typeof event.sessionId === "string" ? event.sessionId : "unknown";
          const direction = event.direction === "outbound" ? "assistant" : event.direction === "inbound" ? "user" : "system";
          const text = String(event.text ?? "").replace(/\\s+/g, " ").trim();
          return "[" + at + "] [" + sid + "] " + direction + ": " + text;
        });
        transcriptNode.textContent = lines.join("\\n");
        setStatus("Loaded " + String(lines.length) + " transcript lines", "success");
      }

      function startAutoPoll() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (!autoEnabled) {
          return;
        }
        pollTimer = setInterval(() => { void refreshTranscript(); }, 4000);
      }

      $("refreshBtn").addEventListener("click", async () => {
        await refreshTranscript();
      });
      $("toggleAuto").addEventListener("click", () => {
        autoEnabled = !autoEnabled;
        $("toggleAuto").textContent = "Auto: " + (autoEnabled ? "On" : "Off");
        startAutoPoll();
      });
      $("allSessions").addEventListener("change", () => { void refreshTranscript(); });
      $("transcriptDate").addEventListener("change", () => { void refreshTranscript(); });
      $("sessionId").addEventListener("change", () => { void refreshTranscript(); });

      $("transcriptDate").value = localIsoDate(new Date());
      setStatus("Transcripts ready", "success");
      void refreshTranscript();
      startAutoPoll();
    </script>
  </body>
</html>`;
}
