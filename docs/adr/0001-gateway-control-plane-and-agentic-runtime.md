# ADR 0001: Gateway Control Plane and Agentic Runtime Direction

- Status: Accepted
- Date: 2026-02-27
- Owners: Alfred project maintainers

## Context

Alfred is evolving from command-routed behavior into an agentic orchestration system. We need a durable architecture decision that keeps behavior consistent across channels, avoids channel-specific logic drift, and supports future capability growth (web, memory, notes/files, reminders, sandboxed execution).

We explicitly treat this ADR as a directional architecture contract (language/framework agnostic).

## Decision

1. Channels are transport lanes only.
   - WhatsApp, web UI, TUI, and future channels are ingress/egress adapters.
   - Channels may authenticate sender, derive channel context, normalize payloads, and submit turns.
   - Channels must not own planning, policy, memory, or provider routing logic.

2. Gateway is the single orchestration control plane.
   - All turns execute through canonical phases:
     - normalize -> session -> directives -> plan -> policy -> route -> persist -> dispatch
   - Gateway owns run/session truth, approvals, policy checks, and final dispatch decisions.

3. Agentic-by-default with selective structured execution.
   - Default path: agentic turn loop (LLM-led tool composition under guardrails).
   - Structured RunSpec path: only for high-risk or repeatable workflows.
   - Promotion loop: stable successful agentic patterns can be promoted to structured flows.

4. Tool model: strict contracts; skill model: guidance.
   - Tool contracts are typed, scoped, and deterministic in execution semantics.
   - Skills/system guidance shape reasoning and tool selection, not rigid DAG-only behavior.

5. Worker role is execution plane, not orchestration authority.
   - Worker executes delegated tasks and reports structured status/events.
   - Gateway remains source of truth for retries, cancellation, approval, and user-visible state.

## Rationale

- Prevents transport coupling and behavior drift across channels.
- Keeps safety/policy centralized and auditable.
- Preserves flexibility for unknown tasks while keeping deterministic controls for risky actions.
- Enables incremental growth without rewrites.

## Consequences

Positive:
- Unified behavior across WhatsApp/web/TUI.
- Cleaner observability and debugging from a single orchestration path.
- Safer side-effect handling via centralized policy/approval.

Tradeoffs:
- Gateway complexity increases and must remain modular.
- Requires stronger contract discipline between gateway and worker.

## Non-goals (for this ADR)

- Prescribing implementation language or crate/package layout.
- Forcing all requests into structured RunSpecs.
- Requiring immediate implementation of all future channels or sandbox tiers.

## Implementation Guidance (Near-term)

1. Formalize `ToolSpec` and safety tiers for policy enforcement.
2. Keep channel adapters thin and origin-aware.
3. Maintain agentic turn loop with self-correction and bounded budgets.
4. Use structured RunSpec only when risk/repeatability justifies it.
5. Keep gateway run ledger authoritative and worker event protocol explicit.

## Related Docs

- `docs/channel_control_plane_architecture.md`
- `docs/agentic_vision.md`
- `docs/detailed_project_plan.md`
- `docs/features.md`
