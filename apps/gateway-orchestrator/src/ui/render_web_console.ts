export function renderWebConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alfred Console</title>
    <style>
      :root {
        --bg: #f3efe7;
        --panel: #fffaf1;
        --ink: #1f1f1f;
        --muted: #615f59;
        --line: #d8d2c5;
        --accent: #0f766e;
        --accent-soft: #d9f2ef;
        --warn: #a16207;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(1200px 500px at 90% -10%, #dff0ea 0%, transparent 60%),
          radial-gradient(800px 400px at -10% 110%, #efe4d0 0%, transparent 60%),
          var(--bg);
      }
      header {
        padding: 20px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in oklab, var(--panel) 92%, white 8%);
      }
      h1 {
        margin: 0;
        font-size: 22px;
        letter-spacing: 0.2px;
      }
      .subtitle {
        margin-top: 6px;
        color: var(--muted);
        font-size: 13px;
      }
      .layout {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 16px;
        padding: 16px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.05);
      }
      .panel h2 {
        margin: 0 0 10px;
        font-size: 15px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-bottom: 10px;
      }
      label {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 5px;
      }
      input, textarea, select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 9px;
        font: inherit;
        background: #fff;
      }
      textarea {
        min-height: 78px;
        resize: vertical;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      button {
        border: 1px solid color-mix(in oklab, var(--accent) 40%, white 60%);
        background: var(--accent-soft);
        color: #0f3f3a;
        border-radius: 8px;
        padding: 8px 10px;
        font-weight: 600;
        cursor: pointer;
      }
      button.secondary {
        background: #f6f6f6;
        color: #333;
        border-color: var(--line);
      }
      .hint {
        font-size: 12px;
        color: var(--muted);
      }
      #log {
        width: 100%;
        min-height: 500px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #14161a;
        color: #c7f2d4;
        padding: 10px;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .pill {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 999px;
        background: #ece8dd;
        font-size: 11px;
        margin-right: 4px;
        margin-bottom: 4px;
      }
      .status {
        margin-top: 8px;
        font-size: 12px;
        color: var(--warn);
      }
      .status[data-state="busy"] {
        color: var(--accent);
      }
      .status[data-state="success"] {
        color: #166534;
      }
      .status[data-state="error"] {
        color: #b42318;
      }
      @media (max-width: 1000px) {
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Alfred Test Console</h1>
      <div class="subtitle">Two test paths: web console now, WhatsApp/Baileys simulation now, real WhatsApp later.</div>
    </header>

    <main class="layout">
      <section class="panel">
        <h2>Chat + Job Submission</h2>
        <div class="row">
          <div>
            <label for="sessionId">Session ID</label>
            <input id="sessionId" value="owner@s.whatsapp.net" />
          </div>
          <div>
            <label for="mode">Ingress Mode</label>
            <select id="mode">
              <option value="direct">Direct Inbound</option>
              <option value="baileys">Baileys Simulated</option>
            </select>
          </div>
        </div>
        <label for="message">Message</label>
        <textarea id="message" placeholder="Try: /task add call dentist"></textarea>
        <div class="actions">
          <button id="sendChat">Send Message</button>
          <button class="secondary" id="sendJob">Send as Async Job</button>
          <button class="secondary" id="healthBtn">Health</button>
        </div>
        <div class="hint">Quick commands: <span class="pill">/task add ...</span><span class="pill">/note add ...</span><span class="pill">/remind &lt;ISO&gt; ...</span><span class="pill">/auth connect</span><span class="pill">/auth status</span><span class="pill">/auth limits</span><span class="pill">send ...</span><span class="pill">approve &lt;token&gt;</span></div>
        <div class="status" id="statusLine"></div>
      </section>

      <section class="panel">
        <h2>Job Controls</h2>
        <div class="row">
          <div>
            <label for="jobId">Job ID</label>
            <input id="jobId" placeholder="paste job id" />
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="actions">
              <button class="secondary" id="jobStatus">Status</button>
              <button class="secondary" id="jobCancel">Cancel</button>
              <button class="secondary" id="jobRetry">Retry</button>
            </div>
          </div>
        </div>

        <h2>Memory</h2>
        <div class="row">
          <div>
            <label for="memoryQuery">Search Query</label>
            <input id="memoryQuery" placeholder="what did we decide" />
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="actions">
              <button class="secondary" id="memorySearch">Search</button>
              <button class="secondary" id="memorySync">Sync</button>
              <button class="secondary" id="memoryStatus">Status</button>
            </div>
          </div>
        </div>

        <h2>OAuth (OpenAI)</h2>
        <div class="row">
          <div>
            <label for="oauthSession">OAuth Session</label>
            <input id="oauthSession" placeholder="defaults to Session ID above" />
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="actions">
              <button class="secondary" id="oauthConnect">Connect</button>
              <button class="secondary" id="oauthStatus">Status</button>
              <button class="secondary" id="oauthLimits">Rate Limits</button>
              <button class="secondary" id="oauthDisconnect">Disconnect</button>
            </div>
          </div>
        </div>
      </section>

      <section class="panel" style="grid-column: 1 / -1;">
        <h2>Console Output</h2>
        <pre id="log"></pre>
      </section>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const log = $("log");
      const statusLine = $("statusLine");

      function stamp() {
        return new Date().toISOString();
      }

      function pushLog(label, payload) {
        const line = "[" + stamp() + "] " + label + "\\n" + (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)) + "\\n";
        log.textContent += line + "\\n";
        log.scrollTop = log.scrollHeight;
      }

      async function api(method, url, body) {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

        let data = null;
        try {
          data = await res.json();
        } catch {
          data = { raw: await res.text() };
        }

        return { ok: res.ok, status: res.status, data };
      }

      function setStatus(text, state = "idle") {
        statusLine.textContent = text;
        statusLine.dataset.state = state;
      }

      const sendChatBtn = $("sendChat");
      const sendJobBtn = $("sendJob");

      function setSendingUi(active) {
        sendChatBtn.disabled = active;
        sendJobBtn.disabled = active;
      }

      async function withSendingUi(label, fn) {
        setSendingUi(true);
        setStatus(label + " in progress...", "busy");
        try {
          return await fn();
        } finally {
          setSendingUi(false);
        }
      }

      $("sendChat").addEventListener("click", async () => {
        const sessionId = $("sessionId").value.trim();
        const text = $("message").value;
        const mode = $("mode").value;

        if (!sessionId || !text.trim()) {
          setStatus("Session and message are required.", "error");
          return;
        }

        pushLog("SEND_CHAT_REQUEST", {
          sessionId,
          mode,
          chars: text.length
        });

        try {
          const response = await withSendingUi("SEND_CHAT", async () => {
            if (mode === "baileys") {
              return api("POST", "/v1/whatsapp/baileys/inbound", {
                key: { id: "web-" + Date.now(), remoteJid: sessionId },
                message: { conversation: text }
              });
            }

            return api("POST", "/v1/messages/inbound", {
              sessionId,
              text,
              requestJob: false
            });
          });

          pushLog("SEND_CHAT", response);
          setStatus("Last action: SEND_CHAT (" + response.status + ")", response.ok ? "success" : "error");
          if (response.data?.jobId) {
            $("jobId").value = response.data.jobId;
          }
        } catch (error) {
          pushLog("SEND_CHAT_ERROR", String(error));
          setStatus("SEND_CHAT failed before response.", "error");
        }
      });

      $("sendJob").addEventListener("click", async () => {
        const sessionId = $("sessionId").value.trim();
        const text = $("message").value;
        const mode = $("mode").value;

        if (!sessionId || !text.trim()) {
          setStatus("Session and message are required.", "error");
          return;
        }

        pushLog("SEND_JOB_REQUEST", {
          sessionId,
          mode,
          chars: text.length
        });

        try {
          const response = await withSendingUi("SEND_JOB", async () => {
            if (mode === "baileys") {
              return api("POST", "/v1/whatsapp/baileys/inbound", {
                key: { id: "web-job-" + Date.now(), remoteJid: sessionId },
                message: { conversation: "/job " + text }
              });
            }

            return api("POST", "/v1/messages/inbound", {
              sessionId,
              text,
              requestJob: true
            });
          });

          pushLog("SEND_JOB", response);
          setStatus("Last action: SEND_JOB (" + response.status + ")", response.ok ? "success" : "error");
          if (response.data?.jobId) {
            $("jobId").value = response.data.jobId;
          }
        } catch (error) {
          pushLog("SEND_JOB_ERROR", String(error));
          setStatus("SEND_JOB failed before response.", "error");
        }
      });

      $("healthBtn").addEventListener("click", async () => {
        const response = await api("GET", "/health");
        pushLog("HEALTH", response);
        setStatus("Last action: HEALTH (" + response.status + ")");
      });

      $("jobStatus").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.");
        const response = await api("GET", "/v1/jobs/" + jobId);
        pushLog("JOB_STATUS", response);
      });

      $("jobCancel").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.");
        const response = await api("POST", "/v1/jobs/" + jobId + "/cancel", {});
        pushLog("JOB_CANCEL", response);
      });

      $("jobRetry").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.");
        const response = await api("POST", "/v1/jobs/" + jobId + "/retry", {});
        pushLog("JOB_RETRY", response);
        if (response.data?.jobId) {
          $("jobId").value = response.data.jobId;
        }
      });

      $("memorySearch").addEventListener("click", async () => {
        const q = encodeURIComponent($("memoryQuery").value.trim());
        const response = await api("GET", "/v1/memory/search?q=" + q);
        pushLog("MEMORY_SEARCH", response);
      });

      $("memorySync").addEventListener("click", async () => {
        const response = await api("POST", "/v1/memory/sync", {});
        pushLog("MEMORY_SYNC", response);
      });

      $("memoryStatus").addEventListener("click", async () => {
        const response = await api("GET", "/v1/memory/status");
        pushLog("MEMORY_STATUS", response);
      });

      function selectedOAuthSession() {
        const override = $("oauthSession").value.trim();
        if (override) {
          return override;
        }
        return $("sessionId").value.trim();
      }

      $("oauthConnect").addEventListener("click", async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) return setStatus("Session ID is required.");
        const response = await api("POST", "/v1/auth/openai/start", { sessionId: sessionId });
        pushLog("OAUTH_CONNECT", response);
        if (response.data?.authorizationUrl) {
          setStatus("Opened OAuth authorize page in a new tab.");
          window.open(response.data.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      });

      $("oauthStatus").addEventListener("click", async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) return setStatus("Session ID is required.");
        const response = await api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(sessionId));
        pushLog("OAUTH_STATUS", response);
        if (response.data?.connected === false) {
          setStatus("Codex auth unavailable; chat may use API key fallback if configured.", "error");
        }
      });

      $("oauthLimits").addEventListener("click", async () => {
        const response = await api("GET", "/v1/auth/openai/rate-limits");
        pushLog("OAUTH_RATE_LIMITS", response);
      });

      $("oauthDisconnect").addEventListener("click", async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) return setStatus("Session ID is required.");
        const response = await api("POST", "/v1/auth/openai/disconnect", { sessionId: sessionId });
        pushLog("OAUTH_DISCONNECT", response);
      });

      pushLog("READY", "Web console loaded. Use controls above.");
      void (async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) {
          return;
        }
        const response = await api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(sessionId));
        pushLog("OAUTH_STATUS_BOOT", response);
        if (response.data?.connected === false) {
          setStatus("Codex auth unavailable; chat may use API key fallback if configured.", "error");
        }
      })();
    </script>
  </body>
</html>`;
}
