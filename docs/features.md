# Key Feature Set

## Product Goal

Deliver a WhatsApp-first self-hosted personal agent that can complete practical tasks safely, with auditable execution and strong memory recall.

## MVP Features (v1)

## 1) Persistent Gateway + Conversational Orchestration

Description:
- Always-on gateway process handles inbound/outbound chat and routes requests.

Acceptance criteria:
- Gateway stays responsive for normal chat turns.
- Chat lane is serialized per user for deterministic context.
- Health endpoint reports service status.

Testing:
- Automated: lane routing and config tests.
- Manual: send multiple sequential prompts and verify deterministic responses.

## 2) Async Job Lane for Long-running Tasks

Description:
- Long jobs execute asynchronously in worker process while chat remains usable.

Acceptance criteria:
- Jobs return ticket IDs and support status/cancel/retry.
- Worker can process queued jobs with deterministic completion states.
- Chat remains available while job is running.

Testing:
- Automated: queue handoff integration test.
- Manual: submit job, keep chatting, observe status updates.

## 3) External Skill Integration Contract (No In-repo Skills)

Description:
- Core system integrates external skills from allowlisted git repos pinned to commit SHA.

Acceptance criteria:
- Skill install metadata stores source + pinned revision.
- Invocation uses typed JSON I/O contract.
- Structured errors are captured in receipts.

Testing:
- Automated: manifest and invocation contract tests.
- Manual: register external skill and run contract validation.

## 4) Receipts and Auditability

Description:
- Every job emits machine-readable and user-visible receipt data.

Acceptance criteria:
- Receipt includes route, actions, artifacts, policy decisions, timings, status.
- User receives concise final outcome summary.
- Logs are retained and queryable locally for debugging.

Testing:
- Automated: receipt field completeness tests.
- Manual: inspect receipt after success/failure/cancel scenarios.

## 5) Memory v1 (Markdown + SQLite Index)

Description:
- Markdown memory files remain source of truth; SQLite index enables fast recall.

Acceptance criteria:
- Search returns snippet + source file/line citations.
- Hybrid retrieval uses vector + keyword ranking.
- Manual notes and confirmed durable facts append without overwrite.

Testing:
- Automated: indexing/search/ranking tests.
- Manual: add notes and verify recall to cited decisions/preferences/todos.

## 6) Built-in Daily Utility

Description:
- Core includes reminders and simple notes/tasks without heavy external tools.

Acceptance criteria:
- Reminder creation, listing, and trigger notifications work.
- User timezone is respected.
- Daily backup reminder appears when overdue.

Testing:
- Automated: reminder scheduling tests.
- Manual: create reminder and verify trigger behavior.

## 7) Dual Test Interfaces (Web + Live WhatsApp)

Description:
- Provide a simple browser console for fast end-to-end testing and a live Baileys WhatsApp runtime for real device-linked validation.

Acceptance criteria:
- `GET /ui` serves a local test console for chat, async job, and memory endpoints.
- Root route redirects to `/ui` for quick local access.
- Live runtime endpoints (`/v1/whatsapp/live/status`, `/v1/whatsapp/live/connect`, `/v1/whatsapp/live/disconnect`) expose connection control and status.
- Baileys inbound relay can be token-protected (`x-baileys-inbound-token`) to reduce spoofed ingress risk.
- Live inbound messages can be gated by required command prefix (default `/alfred`) and optional sender allowlist.
- Optional single-number test mode can allow `fromMe` messages when explicitly enabled.
- Linking QR behavior is guarded with a capped generation window (`WHATSAPP_BAILEYS_MAX_QR_GENERATIONS`, default `3`) so runaway QR churn stops until the operator re-initiates connect.
- Web UI auto-refreshes live WhatsApp status so QR image/raw payload update without repeated manual status clicks.
- QR image payload is rendered by the gateway (`qrImageDataUrl`) so linking does not rely on browser CDN script availability.
- Web UI includes source-at-a-glance cards and change logs for Gateway/Auth/WhatsApp/Memory so operators can track cross-service state without tailing terminal output.
- Unified interaction stream is available in `/ui` from persisted backend events (inbound/outbound/system) across direct API, WhatsApp ingress, and worker-delivered notifications.
- Gateway shutdown now preserves Baileys linked-device auth state (no forced logout), so restarting the process should not require re-linking by default.
- Stream transport supports real-time server-sent events (`/v1/stream/events/subscribe`) with automatic poll fallback in `/ui`.
- Identity mapping is persisted (`whatsapp_jid -> authSessionId`) so WhatsApp messages can route to the intended auth profile/session for OAuth-backed LLM calls.
- Inbound history-sync noise is filtered before chat routing by ignoring non-`notify` upserts, stale pre-live timestamps, and duplicate message IDs.
- Live WhatsApp status includes accepted/ignored inbound counters and sync mode so operators can verify context-bloat protection behavior.
- Stream API supports low-noise mode by default (`chat`/`command`/`job`/`error`) with optional noisy-event inclusion in `/ui` for deeper diagnostics.
- Stream persistence has retention and noise controls (`STREAM_MAX_EVENTS`, `STREAM_RETENTION_DAYS`, `STREAM_DEDUPE_WINDOW_MS`) to keep long-running state bounded.
- `/ui` includes a persisted session transcript panel so operators can reload and inspect prior conversation turns after refresh/restart.

Testing:
- Automated: route-level/UI render tests for live WhatsApp endpoints plus unit coverage for Baileys runtime filtering/token authorization.
- Manual: use browser console for chat/job/memory and run linked-device connect/status/disconnect flow with WhatsApp message send/receive verification.

## 8) OAuth Connection Layer (OpenAI First)

Description:
- Add OAuth-first LLM connection flow with Codex app-server as the primary ChatGPT auth backend and API key fallback.

Acceptance criteria:
- Web/API endpoint can start Codex login and return an authorization URL (`account/login/start`).
- Auth status and plan visibility are available from `account/read`.
- Rate limit visibility is available from `account/rateLimits/read`.
- WhatsApp command path supports `/auth connect`, `/auth status`, `/auth limits`, and `/auth disconnect`.
- Regular chat turns route to Codex turns when ChatGPT auth is connected, with API key fallback when unavailable.
- Web console supports explicit LLM auth preference selection per request (`auto`, `oauth`, `api_key`) so operators can force-test fallback paths intentionally.
- When no backend credential is available, chat returns explicit guidance instead of silent `ack:` fallback.
- Normal chat turns can inject top memory snippets into prompt context and append source references for auditable recall.
- Normal chat turns can also inject recent persisted conversation context (bounded window) to improve continuity after reconnects/restarts.

Testing:
- Automated: OAuth service unit tests, command parsing tests, and integration flow for connect/status/disconnect.
- Manual: run OAuth connect from `/ui`, complete callback, verify status in both web console and chat commands.

## 9) Heartbeat Reliability Loop

Description:
- Add a periodic low-noise heartbeat that checks runtime signals and only emits alerts when something needs attention.

Acceptance criteria:
- Heartbeat supports enable/disable, interval, active-hour window, idle-queue gate, and dedupe window configuration.
- Heartbeat can explicitly monitor OpenAI auth connectivity, WhatsApp live connectivity, and long-running job thresholds.
- Heartbeat status/config/run APIs are available (`/v1/heartbeat/status`, `/v1/heartbeat/configure`, `/v1/heartbeat/run`).
- `/ui` exposes heartbeat controls and status summary for manual testing.
- Repeated identical alerts are deduped within configured dedupe window.
- `HEARTBEAT_OK` can be suppressed to avoid spam.

Testing:
- Automated: unit coverage for heartbeat alerting, queue-busy gating, dedupe behavior, and config parsing.
- Manual: configure heartbeat in `/ui`, run now, and validate status transitions plus alert suppression/dedupe.

## Security Baseline (v1)

- Side-effect actions require explicit confirmation.
- Skill execution network is deny-by-default with allowlist exceptions.
- Cancellation and retries are auditable.
- OAuth-first auth with API key fallback if entitlement is unavailable.

## Deferred to v2/v3

- Public artifact download links.
- Container-based hardened sandbox layers.
- Multi-user tenancy.
- Self-healing/self-building (PR-only proposals, plain-language review UI, canary rollback).
- Additional skill distribution channels (`npm`, `npx`, `brew`).
