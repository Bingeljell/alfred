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
        transition: transform 120ms ease, box-shadow 140ms ease, opacity 120ms ease;
      }
      button:active {
        transform: translateY(1px);
      }
      button[data-busy="true"] {
        box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--accent) 35%, white 65%);
      }
      button.secondary {
        background: #f6f6f6;
        color: #333;
        border-color: var(--line);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
      .hint {
        font-size: 12px;
        color: var(--muted);
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .inline-control {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      .inline-control input {
        width: auto;
        margin: 0;
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
      .auth-summary[data-state="connected"] {
        color: #166534;
      }
      .auth-summary[data-state="disconnected"] {
        color: #b42318;
      }
      .setup-box {
        margin-top: 10px;
        border: 1px dashed var(--line);
        border-radius: 10px;
        padding: 10px;
        background: #fffdf8;
      }
      .setup-box h3 {
        margin: 0 0 8px;
        font-size: 13px;
      }
      .setup-steps {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        color: var(--muted);
      }
      .setup-steps li {
        margin-bottom: 4px;
      }
      .state-badge {
        display: inline-block;
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.2px;
        border: 1px solid var(--line);
        background: #f3f4f6;
        color: #1f2937;
      }
      .state-badge[data-state="connected"] {
        background: #dcfce7;
        border-color: #86efac;
        color: #166534;
      }
      .state-badge[data-state="connecting"] {
        background: #ffedd5;
        border-color: #fdba74;
        color: #9a3412;
      }
      .state-badge[data-state="disconnected"] {
        background: #fee2e2;
        border-color: #fca5a5;
        color: #991b1b;
      }
      .mono {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      .qr-preview {
        margin-top: 10px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #ffffff;
        padding: 10px;
      }
      .qr-preview img {
        width: 240px;
        height: 240px;
        max-width: 100%;
        display: none;
        image-rendering: pixelated;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #ffffff;
      }
      .qr-preview .hint {
        margin-top: 8px;
      }
      #waQrRaw {
        min-height: 88px;
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
        <div class="hint auth-summary" id="authSummary" data-state="unknown">Auth: unknown</div>

        <h2>Live WhatsApp (Baileys)</h2>
        <div class="actions">
          <span class="state-badge" id="waLiveBadge" data-state="unknown">unknown</span>
        </div>
        <div class="actions">
          <button class="secondary" id="waLiveStatus">Live Status</button>
          <button class="secondary" id="waLiveConnect">Live Connect</button>
          <button class="secondary" id="waLiveDisconnect">Live Disconnect</button>
          <button class="secondary" id="waCopyEnv">Copy .env Setup</button>
        </div>
        <div class="hint auth-summary" id="waLiveSummary" data-state="unknown">WhatsApp: not checked</div>
        <div class="setup-box">
          <h3>WhatsApp Setup Flow</h3>
          <ol class="setup-steps">
            <li>Set provider to <span class="mono">baileys</span> and restart gateway.</li>
            <li>Click <strong>Live Connect</strong>.</li>
            <li>Scan the QR image below immediately from WhatsApp Linked Devices.</li>
            <li>Send a test message prefixed with <span class="mono">/alfred</span>.</li>
          </ol>
          <div class="hint" id="waSetupNext">Next step: click <strong>Live Status</strong> to confirm runtime is configured.</div>
          <div class="qr-preview">
            <img id="waQrImage" alt="WhatsApp link QR code" />
            <div class="hint" id="waQrHint">QR will appear here after you click Live Connect.</div>
          </div>
          <details>
            <summary class="hint">Raw QR (advanced)</summary>
            <textarea id="waQrRaw" readonly placeholder="QR payload appears here when available"></textarea>
          </details>
        </div>
      </section>

      <section class="panel" style="grid-column: 1 / -1;">
        <h2>Console Output</h2>
        <div class="toolbar">
          <label class="inline-control" for="logNewestFirst">
            <input type="checkbox" id="logNewestFirst" checked />
            Newest first
          </label>
          <button class="secondary" id="logClear">Clear Console</button>
        </div>
        <pre id="log"></pre>
      </section>
    </main>

    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
    <script>
      const $ = (id) => document.getElementById(id);
      const log = $("log");
      const statusLine = $("statusLine");
      const authSummary = $("authSummary");
      const waLiveSummary = $("waLiveSummary");
      const waLiveBadge = $("waLiveBadge");
      const waSetupNext = $("waSetupNext");
      const waQrRaw = $("waQrRaw");
      const waQrImage = $("waQrImage");
      const waQrHint = $("waQrHint");
      const logNewestFirst = $("logNewestFirst");

      function stamp() {
        return new Date().toISOString();
      }

      function pushLog(label, payload) {
        const line = "[" + stamp() + "] " + label + "\\n" + (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)) + "\\n";
        if (logNewestFirst.checked) {
          log.textContent = line + "\\n" + log.textContent;
          log.scrollTop = 0;
        } else {
          log.textContent += line + "\\n";
          log.scrollTop = log.scrollHeight;
        }
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

      function setButtonBusy(button, busy) {
        if (!button) {
          return;
        }
        button.dataset.busy = busy ? "true" : "false";
        button.disabled = busy;
      }

      async function runButtonAction(button, label, work) {
        setButtonBusy(button, true);
        setStatus(label + " in progress...", "busy");
        try {
          return await work();
        } finally {
          setButtonBusy(button, false);
        }
      }

      const sendChatBtn = $("sendChat");
      const sendJobBtn = $("sendJob");

      function setSendingUi(active) {
        setButtonBusy(sendChatBtn, active);
        setButtonBusy(sendJobBtn, active);
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

      function renderAuthSummary(status) {
        if (!status || typeof status !== "object") {
          authSummary.textContent = "Auth: unavailable";
          authSummary.dataset.state = "disconnected";
          return;
        }

        const connected = status.connected === true;
        const identity = status.email ? status.email : "unknown account";
        const plan = status.planType ? " (" + status.planType + ")" : "";
        const telemetry = status.telemetry || {};
        const lastLoginAt = telemetry.lastLogin && telemetry.lastLogin.at ? telemetry.lastLogin.at : "n/a";
        const lastDisconnectAt = telemetry.lastDisconnectAt ? telemetry.lastDisconnectAt : "n/a";
        authSummary.textContent = connected
          ? "Connected: " + identity + plan + " | last login: " + lastLoginAt + " | last disconnect: " + lastDisconnectAt
          : "Disconnected | last login: " + lastLoginAt + " | last disconnect: " + lastDisconnectAt;
        authSummary.dataset.state = connected ? "connected" : "disconnected";
      }

      function renderWaLiveSummary(status) {
        if (!status || typeof status !== "object") {
          waLiveSummary.textContent = "WhatsApp: unavailable";
          waLiveSummary.dataset.state = "disconnected";
          waLiveBadge.textContent = "unavailable";
          waLiveBadge.dataset.state = "disconnected";
          waSetupNext.textContent = "Next step: set WHATSAPP_PROVIDER=baileys, restart gateway, then click Live Status.";
          renderWaQrPreview("");
          return;
        }

        if (status.error === "whatsapp_live_not_configured") {
          waLiveSummary.textContent = "WhatsApp live runtime is not configured in this process.";
          waLiveSummary.dataset.state = "disconnected";
          waLiveBadge.textContent = "not configured";
          waLiveBadge.dataset.state = "disconnected";
          waSetupNext.textContent = "Next step: set WHATSAPP_PROVIDER=baileys in .env, restart gateway, then click Live Connect.";
          renderWaQrPreview("");
          return;
        }

        const connected = status.connected === true;
        const state = status.state ? String(status.state) : "unknown";
        const me = status.meId ? String(status.meId) : "n/a";
        const qr = status.qr ? "qr_ready" : "no_qr";
        const lastError = status.lastError ? String(status.lastError) : "none";
        waLiveSummary.textContent =
          "WhatsApp " + (connected ? "connected" : "not connected") + " | state: " + state + " | me: " + me + " | " + qr + " | lastError: " + lastError;
        waLiveSummary.dataset.state = connected ? "connected" : "disconnected";
        waLiveBadge.textContent = state;
        waLiveBadge.dataset.state = connected ? "connected" : state === "connecting" ? "connecting" : "disconnected";

        if (connected) {
          waSetupNext.textContent = "Connected. Send a WhatsApp message starting with /alfred to test command/chat handling.";
        } else if (status.qr) {
          waSetupNext.textContent = "QR is ready. Scan it from WhatsApp Linked Devices now.";
        } else if (state === "connecting") {
          waSetupNext.textContent = "Connecting. Wait for QR to appear in status.";
        } else {
          waSetupNext.textContent = "Not connected. Click Live Connect to start WhatsApp linking.";
        }
        renderWaQrPreview(status.qr, { connected, state });
      }

      function renderWaQrPreview(qrValue, context) {
        const raw = qrValue ? String(qrValue) : "";
        const connected = context?.connected === true;
        const state = context?.state ? String(context.state) : "unknown";
        waQrRaw.value = raw;

        if (!raw) {
          waQrImage.style.display = "none";
          waQrImage.removeAttribute("src");
          if (connected) {
            waQrHint.textContent = "Device is linked. A new QR appears only when you reconnect.";
          } else if (state === "connecting") {
            waQrHint.textContent = "Waiting for WhatsApp QR. Keep this page open and use Live Status if needed.";
          } else {
            waQrHint.textContent = "QR will appear here after you click Live Connect.";
          }
          return;
        }

        if (!window.QRCode || typeof window.QRCode.toDataURL !== "function") {
          waQrImage.style.display = "none";
          waQrImage.removeAttribute("src");
          waQrHint.textContent = "QR renderer not loaded. Use raw QR as fallback or refresh the page.";
          return;
        }

        window.QRCode.toDataURL(raw, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 320,
          color: { dark: "#111827", light: "#ffffff" }
        }, (error, dataUrl) => {
          if (error || !dataUrl) {
            waQrImage.style.display = "none";
            waQrImage.removeAttribute("src");
            waQrHint.textContent = "Could not render QR image. Use raw QR as fallback.";
            return;
          }

          waQrImage.src = dataUrl;
          waQrImage.style.display = "block";
          waQrHint.textContent = "Scan now from WhatsApp Linked Devices. This QR can expire quickly.";
        });
      }

      const waEnvSnippet = [
        "WHATSAPP_PROVIDER=baileys",
        "WHATSAPP_BAILEYS_AUTO_CONNECT=false",
        "WHATSAPP_BAILEYS_AUTH_DIR=./state/whatsapp/baileys_auth",
        "WHATSAPP_BAILEYS_INBOUND_TOKEN=replace_with_strong_token",
        "WHATSAPP_BAILEYS_REQUIRE_PREFIX=/alfred",
        "WHATSAPP_BAILEYS_ALLOW_SELF_FROM_ME=true"
      ].join("\\n");

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
        const response = await runButtonAction($("healthBtn"), "HEALTH", () => api("GET", "/health"));
        pushLog("HEALTH", response);
        setStatus("Last action: HEALTH (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("jobStatus").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.", "error");
        const response = await runButtonAction($("jobStatus"), "JOB_STATUS", () => api("GET", "/v1/jobs/" + jobId));
        pushLog("JOB_STATUS", response);
        setStatus("Last action: JOB_STATUS (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("jobCancel").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.", "error");
        const response = await runButtonAction($("jobCancel"), "JOB_CANCEL", () =>
          api("POST", "/v1/jobs/" + jobId + "/cancel", {})
        );
        pushLog("JOB_CANCEL", response);
        setStatus("Last action: JOB_CANCEL (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("jobRetry").addEventListener("click", async () => {
        const jobId = $("jobId").value.trim();
        if (!jobId) return setStatus("Job ID is required.", "error");
        const response = await runButtonAction($("jobRetry"), "JOB_RETRY", () => api("POST", "/v1/jobs/" + jobId + "/retry", {}));
        pushLog("JOB_RETRY", response);
        setStatus("Last action: JOB_RETRY (" + response.status + ")", response.ok ? "success" : "error");
        if (response.data?.jobId) {
          $("jobId").value = response.data.jobId;
        }
      });

      $("memorySearch").addEventListener("click", async () => {
        const q = encodeURIComponent($("memoryQuery").value.trim());
        const response = await runButtonAction($("memorySearch"), "MEMORY_SEARCH", () => api("GET", "/v1/memory/search?q=" + q));
        pushLog("MEMORY_SEARCH", response);
        setStatus("Last action: MEMORY_SEARCH (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("memorySync").addEventListener("click", async () => {
        const response = await runButtonAction($("memorySync"), "MEMORY_SYNC", () => api("POST", "/v1/memory/sync", {}));
        pushLog("MEMORY_SYNC", response);
        setStatus("Last action: MEMORY_SYNC (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("memoryStatus").addEventListener("click", async () => {
        const response = await runButtonAction($("memoryStatus"), "MEMORY_STATUS", () => api("GET", "/v1/memory/status"));
        pushLog("MEMORY_STATUS", response);
        setStatus("Last action: MEMORY_STATUS (" + response.status + ")", response.ok ? "success" : "error");
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
        if (!sessionId) return setStatus("Session ID is required.", "error");
        const response = await runButtonAction($("oauthConnect"), "OAUTH_CONNECT", () =>
          api("POST", "/v1/auth/openai/start", { sessionId: sessionId })
        );
        pushLog("OAUTH_CONNECT", response);
        setStatus("Last action: OAUTH_CONNECT (" + response.status + ")", response.ok ? "success" : "error");
        if (response.data?.authorizationUrl) {
          setStatus("Opened OAuth authorize page in a new tab.", "success");
          window.open(response.data.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      });

      $("oauthStatus").addEventListener("click", async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) return setStatus("Session ID is required.", "error");
        const response = await runButtonAction($("oauthStatus"), "OAUTH_STATUS", () =>
          api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(sessionId))
        );
        pushLog("OAUTH_STATUS", response);
        renderAuthSummary(response.data);
        setStatus("Last action: OAUTH_STATUS (" + response.status + ")", response.ok ? "success" : "error");
        if (response.data?.connected === false) {
          setStatus("Codex auth unavailable; chat may use API key fallback if configured.", "error");
        }
      });

      $("oauthLimits").addEventListener("click", async () => {
        const response = await runButtonAction($("oauthLimits"), "OAUTH_RATE_LIMITS", () =>
          api("GET", "/v1/auth/openai/rate-limits")
        );
        pushLog("OAUTH_RATE_LIMITS", response);
        setStatus("Last action: OAUTH_RATE_LIMITS (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("oauthDisconnect").addEventListener("click", async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) return setStatus("Session ID is required.", "error");
        const response = await runButtonAction($("oauthDisconnect"), "OAUTH_DISCONNECT", () =>
          api("POST", "/v1/auth/openai/disconnect", { sessionId: sessionId })
        );
        pushLog("OAUTH_DISCONNECT", response);
        setStatus("Last action: OAUTH_DISCONNECT (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("waLiveStatus").addEventListener("click", async () => {
        const response = await runButtonAction($("waLiveStatus"), "WA_LIVE_STATUS", () =>
          api("GET", "/v1/whatsapp/live/status")
        );
        pushLog("WA_LIVE_STATUS", response);
        renderWaLiveSummary(response.data);
        setStatus("Last action: WA_LIVE_STATUS (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("waLiveConnect").addEventListener("click", async () => {
        const response = await runButtonAction($("waLiveConnect"), "WA_LIVE_CONNECT", () =>
          api("POST", "/v1/whatsapp/live/connect", {})
        );
        pushLog("WA_LIVE_CONNECT", response);
        renderWaLiveSummary(response.data);
        setStatus("Last action: WA_LIVE_CONNECT (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("waLiveDisconnect").addEventListener("click", async () => {
        const response = await runButtonAction($("waLiveDisconnect"), "WA_LIVE_DISCONNECT", () =>
          api("POST", "/v1/whatsapp/live/disconnect", {})
        );
        pushLog("WA_LIVE_DISCONNECT", response);
        renderWaLiveSummary(response.data);
        setStatus("Last action: WA_LIVE_DISCONNECT (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("waCopyEnv").addEventListener("click", async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(waEnvSnippet);
            setStatus("Copied WhatsApp .env setup snippet to clipboard.", "success");
          } else {
            pushLog("WA_ENV_SETUP", waEnvSnippet);
            setStatus("Clipboard unavailable. Printed .env setup snippet in console output.", "error");
          }
        } catch {
          pushLog("WA_ENV_SETUP", waEnvSnippet);
          setStatus("Copy failed. Printed .env setup snippet in console output.", "error");
        }
      });

      $("logClear").addEventListener("click", async () => {
        await runButtonAction($("logClear"), "CLEAR_LOG", async () => {
          log.textContent = "";
          return { ok: true, status: 200, data: { cleared: true } };
        });
        setStatus("Console cleared.", "success");
      });

      pushLog("READY", "Web console loaded. Use controls above.");
      void (async () => {
        const sessionId = selectedOAuthSession();
        if (!sessionId) {
          return;
        }
        const response = await api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(sessionId));
        pushLog("OAUTH_STATUS_BOOT", response);
        renderAuthSummary(response.data);
        if (response.data?.connected === false) {
          setStatus("Codex auth unavailable; chat may use API key fallback if configured.", "error");
        }
      })();

      void (async () => {
        const response = await api("GET", "/v1/whatsapp/live/status");
        pushLog("WA_LIVE_STATUS_BOOT", response);
        renderWaLiveSummary(response.data);
      })();
    </script>
  </body>
</html>`;
}
