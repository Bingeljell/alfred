# Detailed Project Plan

## 1) Objective

Build a WhatsApp-first personal agent platform with secure, permissioned skills, auditable execution receipts, and phased delivery where every phase is testable manually and automatically.

## 2) Scope Principles

- Keep the orchestrator minimal and stable.
- Expose typed tools only through skills.
- Enforce least privilege by default.
- Make each phase independently shippable and testable.
- Prefer reversible changes and small commits.

## 3) Proposed Repository Structure

```text
.
├── AGENTS.md
├── Gemini.md
├── docs/
│   ├── Personal_Agent_starter.md
│   ├── detailed_project_plan.md
│   ├── features.md
│   ├── changelog.md
│   └── git_workflow.md
├── apps/
│   ├── orchestrator/           # API/webhooks, routing, policy checks
│   ├── worker/                 # job execution and queues
│   └── cli/                    # local dev/manual test entrypoints
├── packages/
│   ├── contracts/              # schemas: skill manifest, receipts, events
│   ├── policy-engine/          # permission and risk policy evaluation
│   ├── memory/                 # memory read/write and summarization
│   └── provider-adapters/      # LLM provider abstractions
├── skills/
│   ├── writing/                # low-risk starter skill
│   └── video-compress/         # deterministic media processing skill
├── scripts/
│   ├── committer
│   ├── test-unit               # run all unit tests
│   ├── test-integration        # run integration suite
│   ├── test-smoke              # fast end-to-end local smoke tests
│   └── test-manual-checklist   # prints phase-wise manual checklist
└── testdata/
    ├── fixtures/
    └── media-samples/
```

Notes:
- `apps/`, `packages/`, and `skills/` are planned; they are created phase-wise.
- Script names are targets to introduce once runtime/language choice is finalized.

## 4) Phase Plan (Builds on Previous Phases)

## Phase 0: Governance and Planning Baseline (Done)

Deliverables:
- Repository bootstrap, branching/commit workflow, changelog format.
- Initial architecture and product docs.

Testability:
- Automated: script syntax checks where available.
- Manual: verify repo can commit and push via `scripts/committer`.

Exit criteria:
- Feature branch exists, remote tracking enabled, docs baselined.

## Phase 1: Core Runtime Skeleton

Deliverables:
- `apps/orchestrator` skeleton with health endpoint and config loader.
- `apps/worker` skeleton with queue consumer loop.
- `packages/contracts` initial event/job schema definitions.

Automated tests:
- Unit: config validation, schema validation.
- Integration: orchestrator-to-worker job handoff using local queue.
- Smoke: boot orchestrator and worker, submit one sample job.

Manual test:
1. Start orchestrator and worker locally.
2. Send a local CLI/API request.
3. Confirm queued job appears and completes with a stub output.

Exit criteria:
- One end-to-end stub flow works locally with deterministic result.

## Phase 2: WhatsApp Ingress and Artifact Intake

Deliverables:
- Webhook endpoint for inbound messages/media metadata.
- Artifact intake service storing raw files and metadata.
- Idempotent retry handling for repeated webhook deliveries.

Automated tests:
- Unit: webhook signature validation and dedupe logic.
- Integration: webhook payload -> persisted job -> artifact record.
- Contract: inbound message schema fixtures.

Manual test:
1. Use provider sandbox webhook/test payload.
2. Trigger inbound message with text and media.
3. Verify artifact is stored and a job is queued.

Exit criteria:
- Real webhook payload can produce a queued job and traceable artifact.

## Phase 3: Skill Contract and Local Sandbox Runner

Deliverables:
- `packages/contracts`: `skill.yaml` schema (inputs, outputs, permissions).
- Runner interface with ephemeral per-job workspace.
- Permission policy checks: filesystem scope, timeout, network deny default.

Automated tests:
- Unit: permission evaluator and manifest validation.
- Integration: run sample skill with allowed and denied permissions.
- Security regression: ensure blocked network/file operations fail closed.

Manual test:
1. Execute `writing` sample skill on a local job.
2. Execute `video-compress` sample skill on sample media.
3. Attempt disallowed operation and verify explicit denial in receipt/log.

Exit criteria:
- At least two skills execute with policy enforcement and predictable outputs.

## Phase 4: Master Router and Sub-Agent Profiles

Deliverables:
- Router selecting sub-agent profile and skills by intent/risk.
- `SOUL.md` + hard policy split (`POLICY.md`) for sub-agents.
- Deterministic fallback route for ambiguous requests.

Automated tests:
- Unit: routing rules and risk scoring.
- Integration: inbound request -> selected profile -> required skill chain.

Manual test:
1. Submit three intents (writing, video, unsupported).
2. Validate route selection and fallback messaging.
3. Confirm policies cannot be elevated by persona config.

Exit criteria:
- Router is stable with test fixtures and explicit fallback behavior.

## Phase 5: Receipts and Audit Trail

Deliverables:
- Receipt schema and persistence (`job_id`, skill digest, actions, artifacts, cost).
- User-facing summary formatter for WhatsApp responses.
- Audit query endpoint/CLI for debugging.

Automated tests:
- Unit: receipt serialization and summary rendering.
- Integration: full job execution produces complete receipt.
- Regression: required receipt fields always present.

Manual test:
1. Run one writing and one video flow.
2. Inspect stored receipts.
3. Confirm chat-visible summary is concise and accurate.

Exit criteria:
- Every job returns receipt metadata and stored detailed logs.

## Phase 6: Memory Service (Markdown-first)

Deliverables:
- Daily/weekly/profile memory writers.
- Memory retrieval API used by router/skills.
- Redaction rules for sensitive memory updates.

Automated tests:
- Unit: memory extraction/summarization logic.
- Integration: interaction events -> markdown files + retrieval query.

Manual test:
1. Simulate multiple interactions.
2. Verify `memory/YYYY-MM-DD.md`, weekly summary, and profile updates.
3. Confirm retrieval returns relevant snippets.

Exit criteria:
- Memory is persisted and retrievable without vector database dependency.

## Phase 7: Human Gates and High-Risk Controls

Deliverables:
- Explicit confirmation workflows for high-risk actions.
- Approval token lifecycle and timeout behavior.
- Browser automation skill gating model (read-only vs interactive).

Automated tests:
- Unit: gating policy transitions.
- Integration: risky action blocked until explicit confirmation.
- Security: replay/expired approvals rejected.

Manual test:
1. Trigger a high-risk flow.
2. Confirm agent asks for approval and blocks execution.
3. Approve and verify resumed execution with audit event.

Exit criteria:
- High-risk capabilities cannot execute without user approval.

## Phase 8: MVP Hardening and Release Candidate

Deliverables:
- Reliability tuning, observability dashboards/logging, deployment baseline.
- Backup/restore for artifacts and receipts.
- Developer documentation for adding new skills.

Automated tests:
- Load smoke tests on queue/worker path.
- End-to-end regression suite across core flows.
- Backup/restore and migration checks.

Manual test:
1. Run complete scenario matrix (writing/video/business-op skeleton).
2. Validate failure/retry behavior.
3. Verify rollback plan and release checklist.

Exit criteria:
- MVP can run reliably for daily personal usage with auditable behavior.

## 5) Test Plan and Script Roadmap

## Planned Test Types

- Unit tests: pure logic (routing, policy checks, schema validation).
- Integration tests: service boundaries (webhook -> queue -> worker -> receipt).
- End-to-end smoke tests: happy paths for key user jobs.
- Security regression tests: deny-by-default and permission boundary checks.
- Manual test scripts/checklists: reproducible local verification steps.

## Planned Scripts (to introduce when code lands)

- `scripts/test-unit`
- `scripts/test-integration`
- `scripts/test-smoke`
- `scripts/test-security`
- `scripts/test-manual-checklist`

Each script should:
- fail fast on error code,
- print deterministic pass/fail summary,
- be callable in local dev and CI.

## 6) Phase-by-Phase Manual Testing Strategy

- Keep one minimal manual scenario per phase in runnable form.
- Use deterministic fixtures (`testdata/`) to avoid flaky validation.
- Store expected outputs where possible (golden outputs).
- For each phase completion, document:
  - command(s) executed,
  - expected result,
  - actual result.

## 7) Open Decisions Required Before Phase 1 Coding

1. Runtime stack preference (TypeScript vs Python) for orchestrator/worker.
2. Queue choice (Redis/BullMQ vs Temporal or equivalent).
3. Initial WhatsApp provider (Meta Cloud API vs Twilio).
4. Sandbox baseline (container-only vs container+gVisor).
5. Artifact store baseline (local FS vs S3-compatible store).
