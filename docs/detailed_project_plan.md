# Detailed Project Plan

## Objective

Build a WhatsApp-first personal agent that runs on a single self-hosted machine (local dev, then low-cost VM/edge), executes real tasks through external skills, and provides auditable, secure behavior.

## Architectural Decisions (Locked)

- Runtime: TypeScript/Node for v1, Go review in v2/v3.
- WhatsApp connector: Baileys direct.
- Topology: same-machine persistent gateway + worker process.
- Execution lanes:
  - chat lane: per-user serialized turns
  - job lane: async queued jobs for long-running work
- Concurrency:
  - per-user serial chat
  - per-skill caps
  - video jobs: 1 job per worker
- Skills:
  - core repo is integration-only (no in-repo skill implementation)
  - install from allowlisted git repos pinned to commit SHA
  - manual approval for skill updates
  - initial external target: `Bingeljell/videoclipper`
- Security:
  - network default deny for skill runs with explicit allowlist
  - side-effect actions require confirmation
  - transient retries: one automatic retry
  - cancel: best-effort terminate + partial-output status
- Data model:
  - memory canonical truth: markdown files
  - memory retrieval index: SQLite + FTS5 + embeddings
  - operational state: file-first append log with locking and compaction
- LLM auth:
  - OAuth-first
  - fallback prompt for API key if entitlement is unavailable
- Artifacts/logs:
  - local disk artifacts (7-day retention)
  - logs (14-day retention)
  - no public download links in v1
  - oversize output returns structured failure with guidance
- Built-in capabilities in v1: reminders + simple notes/tasks.
- Testing: Vitest + Supertest, phase completion requires automated tests + manual checklist.
- Performance target on low-cost host: text response P95 < 3s.

## Repository Structure (Planned)

```text
.
├── AGENTS.md
├── Gemini.md
├── docs/
│   ├── Personal_Agent_starter.md
│   ├── detailed_project_plan.md
│   ├── features.md
│   ├── progress.md
│   ├── changelog.md
│   └── git_workflow.md
├── apps/
│   ├── gateway-orchestrator/
│   └── worker/
├── packages/
│   ├── contracts/
│   ├── memory/
│   ├── policy-engine/
│   ├── provider-adapters/
│   └── skill-runner/
├── scripts/
│   ├── committer
│   ├── test-unit
│   ├── test-integration
│   ├── test-smoke
│   ├── test-security
│   └── test-manual-checklist
├── memory/
├── state/
└── artifacts/
```

## Phase Plan

## Test Surfaces (Locked)

- Browser-based test console at `GET /ui` for rapid local/manual validation.
- WhatsApp ingress path via Baileys payloads for API-level/manual simulation.
- Future UI tracks (nicer web app + TUI) must call the same gateway APIs to avoid behavior drift.

## Phase 0: Governance and Planning Baseline (Done)

Deliverables:
- Repo workflow, changelog standards, initial architecture docs.

Validation:
- Commit workflow and documentation structure verified.

## Phase 1: Core Runtime Skeleton (Next)

Deliverables:
- `apps/gateway-orchestrator` with health endpoint and local queue integration.
- `apps/worker` with queue consumer loop and deterministic stub processing.
- `packages/contracts` with initial message/job/receipt schemas.
- Test scaffolding and phase test scripts.

Automated tests:
- Unit: config and schema validation.
- Integration: orchestrator to worker job handoff via local queue.
- Smoke: boot components and complete one deterministic stub job.

Manual checklist:
1. Start gateway and worker locally.
2. Submit job request.
3. Verify completion and receipt output.

Definition of done:
- Deterministic end-to-end stub flow passes automated and manual checks.

## Phase 2: WhatsApp Ingress and Async UX

Deliverables:
- Baileys ingress and outbound messaging.
- Deduped inbound normalization.
- Async status updates while chat lane remains responsive.
- Live connection controls (`status/connect/disconnect`) and persisted auth/session path under `state/`.
- Optional inbound token enforcement for provider-to-gateway relay security.
- Prefix-gated inbound command processing (`/alfred`) with optional sender allowlist and explicit self-message mode for one-number testing.

Definition of done:
- Real/sandbox messages can trigger jobs without blocking chat.

## Phase 3: Memory v1

Deliverables:
- Markdown canonical memory store.
- SQLite chunk index with embeddings + FTS5.
- `searchMemory`, `getMemorySnippet`, `appendMemoryNote`, `syncMemory`, `memoryStatus`.
- Citation-first recall policy.

Defaults:
- Chunking: ~500 tokens with 80 overlap.
- Hybrid ranking: 70% vector / 30% keyword.
- Prompt memory budget: max 3 snippets or ~900 tokens.
- Sync triggers: startup, dirty-on-search, debounce watch, hourly tick, manual sync.

Definition of done:
- Top-5 retrieval contains correct snippet >= 80% on project-doc eval set.

## Phase 4: External Skill Integration Contract

Deliverables:
- Allowlisted repo install with commit SHA pinning.
- CLI skill invocation contract.
- Structured error contract and policy enforcement.

Definition of done:
- External skill can be installed, invoked, and audited without adding skill code to this repo.

## Phase 5: Built-in Reminders and Notes + Job Controls

Deliverables:
- Reminders and note/task primitives.
- Job status/cancel/retry in natural language.
- Side-effect approval gates.

Definition of done:
- Daily-use flows work with receipts and policy traceability.

## Phase 6: MVP Hardening for Low-cost Host

Deliverables:
- OAuth Phase 6.1: Codex app-server connect/status/disconnect with ChatGPT login flow (`account/login/start`).
- OAuth entry points from both web console controls and WhatsApp chat commands (`/auth connect`, `/auth status`, `/auth limits`, `/auth disconnect`).
- OpenAI Responses runtime wiring for API-key fallback when Codex auth is unavailable.
- Codex thread runtime wiring for normal chat turns with OAuth-first routing and session-thread persistence.
- Live WhatsApp linking hardening: auto-refresh QR/status in UI and cap QR generation attempts per connect window before manual re-init.
- Live WhatsApp linking reliability: backend-generated QR image payloads (no CDN dependency) returned via live status/connect endpoints.
- Operator observability pass: source-level status cards and change-feed logging in `/ui` for Gateway/Auth/WhatsApp/Memory.
- Retention workers (artifacts/logs).
- Backup reminder using `last_backup_at` memory signal.
- Minimal CI and release checklist.

Definition of done:
- Stable long-running behavior on single-host setup with performance target met.

## Deferred (v2/v3)

- Public artifact links and object storage.
- Container/hardened sandbox upgrades (Docker/gVisor).
- Multi-user tenancy.
- Self-healing/self-building via PR-only flow with plain-language approval UI and canary rollback.
- Expanded skill packaging via npm/npx/brew and richer registry workflows.

## Phase Completion Rule

For every completed task/phase:
- update `docs/progress.md`
- add corresponding `docs/changelog.md` entry in the same commit
- record automated test results and manual checklist outcome
