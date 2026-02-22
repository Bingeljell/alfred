# Key Feature Set

## Product Goal

Deliver a WhatsApp-first personal agent that executes practical tasks through secure, installable skills with full auditability.

## MVP Features (Must Build)

## 1) WhatsApp Task Ingress

Description:
- Receive user text/media requests from WhatsApp and normalize into internal jobs.

Acceptance criteria:
- Inbound message creates a job with user/session context.
- Media references are persisted as artifacts.
- Duplicate webhooks are safely deduplicated.

Testing:
- Automated: webhook schema + dedupe integration tests.
- Manual: send test webhook payload and verify job/artifact records.

## 2) Master Dispatch + Specialist Routing

Description:
- Route each request to the right sub-agent profile and skill chain.

Acceptance criteria:
- Intent-to-route mapping is deterministic for known intents.
- Unsupported/ambiguous requests trigger explicit fallback response.
- Personality instructions cannot override hard policy.

Testing:
- Automated: routing fixtures and risk-scoring unit tests.
- Manual: run sample writing/video/unsupported tasks and inspect route decisions.

## 3) Skill Contract + Execution Runtime

Description:
- Skills are installed capabilities with typed inputs/outputs and explicit permissions.

Acceptance criteria:
- Skill manifests validate against schema.
- Skills run in isolated per-job workspace.
- Denied permissions fail closed with clear error reporting.

Testing:
- Automated: manifest validation, permission enforcement, runtime integration tests.
- Manual: run approved skill actions and one denied action.

## 4) Receipts and Audit Logs

Description:
- Every job emits structured, queryable receipts.

Acceptance criteria:
- Receipt includes job id, selected agent/skills, artifacts, policy decisions, timings.
- Chat-visible summary is returned to user.
- Full logs are retrievable for debugging.

Testing:
- Automated: receipt contract and completeness tests.
- Manual: execute jobs and inspect stored receipts/logs.

## 5) Memory (Markdown-first)

Description:
- Persist daily/weekly summaries and profile facts for recall.

Acceptance criteria:
- Interaction events produce daily and weekly summaries.
- Profile facts can be updated and queried.
- Sensitive updates can be gated.

Testing:
- Automated: memory write/read and summarization tests.
- Manual: run multi-interaction scenario and verify markdown outputs.

## 6) Human Approval Gates for High-Risk Actions

Description:
- Require explicit user confirmation before risky operations.

Acceptance criteria:
- High-risk action pauses and requests confirmation.
- Approval/resume workflow is auditable.
- Expired/replayed approvals are rejected.

Testing:
- Automated: gating state machine tests.
- Manual: trigger risky task and verify block-until-approve behavior.

## Post-MVP Features (After Core Stability)

- Multi-provider LLM account linking and spend controls.
- Signed skill artifacts and stronger supply-chain attestations.
- Remote browser automation skill with strict recording/approval gates.
- Optional vector memory indexing for large history retrieval.
- Desktop companion app and richer operator UI.

## Manual Test Feature Matrix

For each release candidate, manually validate:

1. Text-only writing task from WhatsApp to response and receipt.
2. Video compression task with artifact in/out and receipt.
3. Denied permission path returns safe error.
4. High-risk action requires and records confirmation.
5. Memory retrieval includes expected historical context.

## Non-Goals (Current)

- Fully autonomous unrestricted computer control.
- Unbounded shell access from agents.
- Shipping self-modifying code paths without human-gated review.
