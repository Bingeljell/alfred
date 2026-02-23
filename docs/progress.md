# Project Progress

## Current Phase

- Phase 6: MVP Hardening for Low-cost Host
- Status: In Progress
- Started: 2026-02-23

## Phase Tracker

| Phase | Name | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| 0 | Governance and Planning Baseline | Done | 2026-02-22 | 2026-02-22 | Repo and documentation bootstrap complete. |
| 1 | Core Runtime Skeleton | Done | 2026-02-22 | 2026-02-22 | Gateway/worker runtime, file-backed queue, contracts, and test suite completed. |
| 2 | WhatsApp Ingress and Async UX | Done | 2026-02-22 | 2026-02-22 | Baileys payload normalization, dedupe, async status notifications, and phase tests completed. |
| 3 | Memory v1 | Done | 2026-02-22 | 2026-02-22 | Markdown canonical memory, SQLite FTS index, retrieval APIs, and evaluation smoke tests completed. |
| 4 | External Skill Integration Contract | Done | 2026-02-22 | 2026-02-22 | Allowlisted git install pinned to commit SHA, CLI runner contract, and security policy tests completed. |
| 5 | Built-in Reminders and Notes + Job Controls | Done | 2026-02-22 | 2026-02-22 | Added reminder/task/note commands, approval gating, and job status/cancel/retry control flows with test coverage. |
| 6 | MVP Hardening for Low-cost Host | In Progress | 2026-02-23 | - | Codex app-server auth/runtime wired for web + WhatsApp command flow (`/auth connect/status/limits/disconnect`) with OAuth-first chat turns and OpenAI API key fallback. Added restart-safe stale-thread recovery, boot-time auth status visibility in web console, and persisted auth telemetry (`lastLogin`/disconnect/status checks) across restarts. Remaining: retention, backup reminders, CI, performance tuning. |

## Completion Checklist Template

Use this checklist whenever a phase is completed:

1. Automated tests executed and passing.
2. Manual checklist executed and recorded.
3. `docs/changelog.md` updated with phase/task completion entry.
4. `docs/progress.md` status and dates updated.
5. Commit includes docs + implementation evidence for that phase.
