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
- Gateway acts as control plane only (turn orchestration, policy, routing, persistence, delivery); heavy/background execution is delegated to worker lanes.
- Gateway records explicit run-phase transitions (`normalize -> session -> directives -> plan -> policy -> route -> persist -> dispatch`) in a durable run ledger.
- Run records include immutable run spec basics (session key, idempotency key, model/provider, policy snapshot, skill snapshot) and can be queried via API.

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

## 2.1) Supervisor Fan-out + Multi-worker Execution

Description:
- Add gateway-supervised fan-out runs that spawn bounded child jobs and track parent/child lifecycle while worker concurrency processes them in parallel.

Acceptance criteria:
- Gateway supports supervised web fan-out command path (`/supervise web ...`) with provider selection and child budget controls.
- Supervisor store persists parent/child status and exposes summary/status APIs (`/v1/supervisors`, `/v1/supervisors/:id`).
- Worker supports configurable concurrency (`WORKER_CONCURRENCY`) and can execute queued follow-up chat turns when sessions are busy (`queueMode=collect|followup`).
- Child jobs include bounded retries, time budgets, and token-budget metadata.

Testing:
- Automated: parser/config tests for new controls, gateway fan-out unit coverage, supervisor-store lifecycle tests, and worker progress regression tests.
- Manual: run `/supervise web --providers=openai,brave ...`, verify child jobs + supervisor status, and confirm worker parallelism with `WORKER_CONCURRENCY>1`.

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
- Transcript panel supports day-scoped filtering (default `today`) so operators can inspect historical days without rendering full multi-day transcript payloads in one view.

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

## 10) Capability Policy + Workspace Guardrails

Description:
- Add policy-first controls for external capabilities so development/testing stays bounded and auditable.

Acceptance criteria:
- Policy defaults are env-driven and loaded from `.env` (`ALFRED_*`).
- Approval is enabled by default for external capabilities.
- Dedicated workspace root (`ALFRED_WORKSPACE_DIR`, default `./workspace/alfred`) is auto-created on startup and gitignored.
- `/web <query>` command is available for web research and can be approval-gated.
- Web search supports provider selection (`searxng`, `openai`, `brave`, `perplexity`, `brightdata`, `auto`) via `/web --provider=<provider> ...`, with default provider configured by `ALFRED_WEB_SEARCH_PROVIDER` (default `searxng`).
- SearXNG and BrightData providers support dedicated config (`SEARXNG_SEARCH_*`, `BRIGHTDATA_*`), with BrightData using API key + zone; Brave and Perplexity remain optional API providers (`BRAVE_SEARCH_*`, `PERPLEXITY_*`) while OpenAI provider reuses current Codex/OpenAI chat path.
- Long-running `/web` execution emits an in-flight `running` notification message so operators see progress before final output is returned.
- `/write <relative-path> <text>` writes only inside workspace, is disabled by default, and can be restricted to notes-only paths.
- `/policy` command reports active capability policy state for manual verification.
- Pending approvals can be resolved with natural yes/no replies (`yes` approves latest pending action, `no` rejects latest pending action) in both web chat and WhatsApp, while token-based `approve <token>` remains supported.
- `/approval` / `/approval pending` reports pending approval state (action/token/expiry) for session-level operator visibility.
- Approval state is queryable and resolvable via API (`GET /v1/approvals/pending`, `POST /v1/approvals/resolve`) for cross-channel control surfaces.

Testing:
- Automated: approval-store, command parser, app-route, and gateway-service unit tests for pending approval visibility, token/yes-no resolution, web-search approvals, and file-write policy enforcement.
- Manual: run `/policy`, `/approval pending`, `/web ...`, `/write ...`, and approval API endpoints with different `ALFRED_*` env combinations and verify cross-channel approval/workspace behavior.

## 11) Daily Memory Compaction

Description:
- Add a bounded daily compaction pass that summarizes prior-day conversation events into memory notes so long-running transcripts stay usable without uncontrolled context growth.

Acceptance criteria:
- Compaction runs on startup + interval and only targets prior UTC days (never partial current day).
- Compaction state is persisted (`cursorDate`, `lastCompactedDate`, counters) so restart behavior is deterministic and non-duplicative.
- Summary notes are bounded (`MEMORY_COMPACTION_MAX_NOTE_CHARS`) and include auditable metadata (window, counts, notable events).
- Manual APIs are available for operators: `GET /v1/memory/compaction/status` and `POST /v1/memory/compaction/run`.
- Successful compaction triggers memory index sync and emits a `source=memory` status event to the unified stream.

Testing:
- Automated: unit coverage for compaction success, low-signal skip behavior, invalid manual target handling, config parsing defaults/overrides, and route registration.
- Manual: run compaction status/manual run APIs, verify memory note append for prior day, and verify duplicate re-run is skipped once cursor is current.

## 12) Long-task Worker Routing + Progress UX

Description:
- Route long research-style requests to worker jobs with immediate acknowledgement, incremental progress updates, and paged follow-up delivery.

Acceptance criteria:
- `/web ...` command queues a worker job instead of blocking the chat turn.
- Research-like long requests are heuristically routed to worker with immediate “queued” acknowledgement.
- Worker emits progress events (`progress`, `running`, `succeeded`, `failed`) and gateway surfaces those updates in stream/chat channels.
- User can ask `status?`/`progress` and receive latest active job state + last progress message.
- Long results can be delivered in pages using `#next`/`next` via session-scoped paged response state.

Testing:
- Automated: unit coverage for routed web-search command behavior, progress query handling, `#next` paging, paged store persistence, and worker progress event/reporting.
- Manual: trigger long research request, confirm immediate queue acknowledgement + progress updates, then use `status?` and `#next` until pages are exhausted.

## 13) Planner-first Orchestration + System Prompt Stack

Description:
- Add an LLM intent planner as Alfred’s default decision layer for non-command chat, backed by policy enforcement and an explicit system-prompt stack.

Acceptance criteria:
- Planner runs for normal chat turns and returns structured intent (`chat`, `web_research`, `status_query`, `clarify`, `command`) with confidence.
- Low-confidence plans ask clarifying questions instead of executing uncertain actions.
- System prompt is assembled from dedicated docs files (`docs/alfred_identity.md`, `docs/alfred_capabilities.md`, `docs/alfred_policies.md`).
- Approval mode is configurable via `ALFRED_APPROVAL_MODE` (`strict`, `balanced`, `relaxed`) and enforced in gateway policy checks.
- `balanced` mode allows low-risk research autonomy while preserving guarded write behavior.
- Planner emits a trace event (intent, confidence, reason, chosen action) into the interaction stream for operator visibility in `/ui`.

Testing:
- Automated: unit coverage for planner JSON parsing/heuristic fallback, config parsing for planner + approval mode, and gateway routing behavior under planner decisions.
- Manual: send ambiguous prompt to verify clarification, send research prompt to verify planner-based worker delegation, confirm `STREAM_PLANNER_TRACE` appears in `/ui`, and verify `/policy` reports current approval mode.

## 14) Memory V2 for Autonomy

Description:
- Add checkpoint-style durable memory writes at meaningful boundaries and class-aware retrieval so long-running autonomy remains auditable without context bloat.

Acceptance criteria:
- Gateway writes memory checkpoints on key decision/task boundaries (for example task add/done and approval execute/reject).
- Worker terminal notifications (`succeeded`/`failed`/`cancelled`) are checkpointed as durable memory signals.
- Checkpoint writes are deduplicated and capped per day to prevent unbounded memory growth.
- Memory retrieval for chat supports class-aware context (`fact`, `preference`, `todo`, `decision`) with query-driven filtering.
- Daily compaction output includes class distribution metadata (`memory_class_counts`) and class-tagged notable events.
- Operator endpoint is available for checkpoint runtime visibility: `GET /v1/memory/checkpoints/status`.

Testing:
- Automated: unit coverage for checkpoint write/dedupe/day-limit behavior, class-aware chat-memory retrieval filtering, compaction class-tag output compatibility, and route/UI registration.
- Manual: execute task/approval flows and verify checkpoint status updates, ask class-targeted recall questions (for example decisions vs preferences), and run compaction status/manual run to confirm class counts appear in memory digest notes.

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
