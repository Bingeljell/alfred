import { renderUiHeader } from "./shared_shell";

export function renderUiHomeHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Alfred Dashboard</title>
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
      .layout {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        padding: 14px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        min-width: 0;
      }
      .panel h2 { margin: 0 0 10px; font-size: 15px; }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-bottom: 10px;
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
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
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
      .cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px;
        background: #fff;
      }
      .card[data-state="ok"] { background: #ecfdf3; border-color: #86efac; }
      .card[data-state="warn"] { background: #fff7ed; border-color: #fdba74; }
      .card[data-state="error"] { background: #fef2f2; border-color: #fca5a5; }
      .name { font-size: 11px; color: var(--muted); font-weight: 700; text-transform: uppercase; }
      .value { margin-top: 3px; font-size: 12px; font-weight: 700; }
      .meta { margin-top: 2px; font-size: 11px; color: var(--muted); }
      #statusLine { margin-top: 10px; font-size: 12px; color: var(--muted); }
      #statusLine[data-state="error"] { color: #b42318; }
      #statusLine[data-state="success"] { color: #166534; }
      #log {
        width: 100%;
        min-height: 180px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #111827;
        color: #d1f7dc;
        padding: 8px;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
        white-space: pre-wrap;
        overflow: auto;
      }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
        .cards { grid-template-columns: 1fr; }
        .row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    ${renderUiHeader({
      title: "Alfred Dashboard",
      subtitle: "Connection status and identity bindings.",
      current: "status"
    })}

    <main class="layout">
      <section class="panel">
        <h2>Source Status</h2>
        <div class="cards">
          <div class="card" id="gatewayCard" data-state="warn"><div class="name">Gateway</div><div class="value" id="gatewayValue">Unknown</div><div class="meta" id="gatewayMeta">waiting</div></div>
          <div class="card" id="authCard" data-state="warn"><div class="name">Auth</div><div class="value" id="authValue">Unknown</div><div class="meta" id="authMeta">waiting</div></div>
          <div class="card" id="waCard" data-state="warn"><div class="name">WhatsApp</div><div class="value" id="waValue">Unknown</div><div class="meta" id="waMeta">waiting</div></div>
          <div class="card" id="memoryCard" data-state="warn"><div class="name">Memory</div><div class="value" id="memoryValue">Unknown</div><div class="meta" id="memoryMeta">waiting</div></div>
        </div>
        <div class="actions" style="margin-top:10px;">
          <button class="secondary" id="refreshSources">Refresh Sources</button>
        </div>
      </section>

      <section class="panel">
        <h2>OAuth + WhatsApp</h2>
        <div class="row">
          <div>
            <label for="sessionId">Session ID</label>
            <input id="sessionId" value="owner@s.whatsapp.net" />
          </div>
          <div>
            <label for="oauthSession">OAuth Session (optional override)</label>
            <input id="oauthSession" />
          </div>
        </div>
        <div class="actions">
          <button id="oauthConnect">OAuth Connect</button>
          <button class="secondary" id="oauthStatus">OAuth Status</button>
          <button class="secondary" id="oauthLimits">OAuth Limits</button>
          <button class="secondary" id="oauthDisconnect">OAuth Disconnect</button>
        </div>
        <div class="actions" style="margin-top:10px;">
          <button class="secondary" id="waStatus">WA Status</button>
          <button class="secondary" id="waConnect">WA Connect</button>
          <button class="secondary" id="waDisconnect">WA Disconnect</button>
        </div>
      </section>

      <section class="panel">
        <h2>Identity Bindings</h2>
        <div class="row">
          <div>
            <label for="mapWhatsAppJid">WhatsApp JID</label>
            <input id="mapWhatsAppJid" value="owner@s.whatsapp.net" />
          </div>
          <div>
            <label for="mapAuthSessionId">Auth Session ID</label>
            <input id="mapAuthSessionId" />
          </div>
        </div>
        <div class="actions">
          <button class="secondary" id="mapBind">Bind</button>
          <button class="secondary" id="mapResolve">Resolve</button>
          <button class="secondary" id="mapList">List</button>
        </div>
      </section>

      <section class="panel">
        <h2>Action Log</h2>
        <pre id="log"></pre>
        <div id="statusLine"></div>
      </section>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const log = $("log");
      const statusLine = $("statusLine");

      function stamp() { return new Date().toISOString(); }
      function pushLog(label, payload) {
        const line = "[" + stamp() + "] " + label + "\\n" + (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
        log.textContent = line + "\\n\\n" + log.textContent;
      }
      function setStatus(text, state) {
        statusLine.textContent = text;
        statusLine.dataset.state = state || "idle";
      }
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
      function selectedOAuthSession() {
        const override = $("oauthSession").value.trim();
        if (override) { return override; }
        return $("sessionId").value.trim();
      }
      function setCard(idPrefix, state, value, meta) {
        $(idPrefix + "Card").dataset.state = state;
        $(idPrefix + "Value").textContent = value;
        $(idPrefix + "Meta").textContent = meta;
      }

      async function refreshSources() {
        const health = await api("GET", "/health");
        if (health.ok) {
          const q = health.data?.queue || {};
          const active = Array.isArray(health.data?.activeJobs) ? health.data.activeJobs : [];
          const activeTop = active[0];
          const activeMeta = activeTop
            ? " | active:" +
              String(activeTop.id || "").slice(0, 8) +
              " " +
              String(activeTop.status || "unknown") +
              (activeTop.workerId ? "@" + String(activeTop.workerId) : "") +
              (activeTop.progressPhase ? " [" + String(activeTop.progressPhase) + "]" : "") +
              (activeTop.progress ? " (" + String(activeTop.progress) + ")" : "")
            : "";
          setCard(
            "gateway",
            "ok",
            "ok",
            "queued:" + (q.queued || 0) + " running:" + (q.running || 0) + " failed:" + (q.failed || 0) + activeMeta
          );
        } else {
          setCard("gateway", "error", "error", "HTTP " + health.status);
        }

        const oauth = await api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(selectedOAuthSession()));
        if (oauth.ok && oauth.data?.connected === true) {
          setCard("auth", "ok", "connected", String(oauth.data?.email || oauth.data?.mode || "connected"));
        } else if (oauth.ok) {
          setCard("auth", "warn", "disconnected", String(oauth.data?.mode || "n/a"));
        } else {
          setCard("auth", "error", "error", "HTTP " + oauth.status);
        }

        const wa = await api("GET", "/v1/whatsapp/live/status");
        if (wa.ok && wa.data?.connected === true) {
          setCard("wa", "ok", "connected", String(wa.data?.meId || "linked"));
        } else if (wa.ok) {
          setCard("wa", "warn", String(wa.data?.state || "disconnected"), String(wa.data?.lastError || "n/a"));
        } else {
          setCard("wa", "error", "not ready", "HTTP " + wa.status);
        }

        const memory = await api("GET", "/v1/memory/status");
        if (memory.ok) {
          setCard(
            "memory",
            memory.data?.dirty ? "warn" : "ok",
            "files:" + String(memory.data?.indexedFileCount || 0),
            "chunks:" + String(memory.data?.chunkCount || 0)
          );
        } else {
          setCard("memory", "error", "error", "HTTP " + memory.status);
        }
      }

      $("refreshSources").addEventListener("click", async () => {
        await refreshSources();
        setStatus("Sources refreshed", "success");
      });

      $("oauthConnect").addEventListener("click", async () => {
        const response = await api("POST", "/v1/auth/openai/start", { sessionId: selectedOAuthSession() });
        pushLog("OAUTH_CONNECT", response);
        if (response.ok && response.data?.authorizationUrl) {
          window.open(response.data.authorizationUrl, "_blank", "noopener,noreferrer");
        }
        setStatus("OAuth connect (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });
      $("oauthStatus").addEventListener("click", async () => {
        const response = await api("GET", "/v1/auth/openai/status?sessionId=" + encodeURIComponent(selectedOAuthSession()));
        pushLog("OAUTH_STATUS", response);
        setStatus("OAuth status (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });
      $("oauthLimits").addEventListener("click", async () => {
        const response = await api("GET", "/v1/auth/openai/rate-limits?sessionId=" + encodeURIComponent(selectedOAuthSession()));
        pushLog("OAUTH_LIMITS", response);
        setStatus("OAuth limits (" + response.status + ")", response.ok ? "success" : "error");
      });
      $("oauthDisconnect").addEventListener("click", async () => {
        const response = await api("POST", "/v1/auth/openai/disconnect", { sessionId: selectedOAuthSession() });
        pushLog("OAUTH_DISCONNECT", response);
        setStatus("OAuth disconnect (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });

      $("waStatus").addEventListener("click", async () => {
        const response = await api("GET", "/v1/whatsapp/live/status");
        pushLog("WA_STATUS", response);
        setStatus("WA status (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });
      $("waConnect").addEventListener("click", async () => {
        const response = await api("POST", "/v1/whatsapp/live/connect", {});
        pushLog("WA_CONNECT", response);
        setStatus("WA connect (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });
      $("waDisconnect").addEventListener("click", async () => {
        const response = await api("POST", "/v1/whatsapp/live/disconnect", {});
        pushLog("WA_DISCONNECT", response);
        setStatus("WA disconnect (" + response.status + ")", response.ok ? "success" : "error");
        await refreshSources();
      });

      $("mapBind").addEventListener("click", async () => {
        const whatsAppJid = $("mapWhatsAppJid").value.trim();
        const authSessionId = $("mapAuthSessionId").value.trim() || selectedOAuthSession() || whatsAppJid;
        const response = await api("POST", "/v1/identity/mappings", { whatsAppJid, authSessionId });
        pushLog("MAP_BIND", response);
        setStatus("Mapping bind (" + response.status + ")", response.ok ? "success" : "error");
      });
      $("mapResolve").addEventListener("click", async () => {
        const whatsAppJid = $("mapWhatsAppJid").value.trim();
        const response = await api("GET", "/v1/identity/resolve?whatsAppJid=" + encodeURIComponent(whatsAppJid));
        pushLog("MAP_RESOLVE", response);
        if (response.ok && response.data?.authSessionId) {
          $("mapAuthSessionId").value = String(response.data.authSessionId);
        }
        setStatus("Mapping resolve (" + response.status + ")", response.ok ? "success" : "error");
      });
      $("mapList").addEventListener("click", async () => {
        const response = await api("GET", "/v1/identity/mappings?limit=20");
        pushLog("MAP_LIST", response);
        setStatus("Mapping list (" + response.status + ")", response.ok ? "success" : "error");
      });

      $("sessionId").addEventListener("change", () => {
        const sessionId = $("sessionId").value.trim() || "owner@s.whatsapp.net";
        $("mapWhatsAppJid").value = sessionId;
      });

      $("mapWhatsAppJid").value = $("sessionId").value.trim() || "owner@s.whatsapp.net";
      pushLog("READY", "Dashboard loaded.");
      void refreshSources();
      setInterval(() => { void refreshSources(); }, 5000);
    </script>
  </body>
</html>`;
}
