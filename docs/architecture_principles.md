# Alfred Architecture Principles (Locked)

## Purpose

Capture the long-lived engineering principles we keep regardless of language/runtime choices.
This document is framework-agnostic and applies to Alfred's current TypeScript stack and future rewrites.

## Principles

1. Minimal core, composable behavior
   - Keep the core runtime small.
   - Build capability through composable tools and policies, not large hardcoded feature trees.

2. Gateway-first control plane
   - All channels are ingress/egress lanes.
   - Orchestration truth lives in gateway phases:
     - normalize -> session -> directives -> plan -> policy -> route -> persist -> dispatch

3. Provider-agnostic runtime contracts
   - Planner/runtime code should not depend on vendor-specific model APIs.
   - Model backends are adapters behind a common contract.

4. Typed tools with safety tiers
   - Tools are explicit contracts with schema, capability, and safety tier.
   - Side effects are policy-gated, auditable, and approval-aware.

5. Hybrid execution model
   - Agentic mode is default for novel/ambiguous tasks.
   - Structured run specs are selective for high-risk/repeatable flows.
   - Repeated successful agentic patterns can be promoted to structured flows.

6. Worker as deterministic execution plane
   - Workers execute delegated actions and report state/events.
   - Workers do not own planning authority or policy truth.

7. Memory is local-first and retrieval-driven
   - Human-readable memory remains canonical.
   - Retrieval index exists for speed and bounded prompt usage.
   - Prefer explicit citations for factual recall.

8. Security by isolation and policy, not trust
   - Prompt guidance is useful but not a control boundary.
   - Side effects require enforceable controls (allowlists, approvals, timeouts, budgets, sandboxing).

9. Observability as a first-class feature
   - Every turn and job should be traceable with phase/state transitions.
   - Progress, failures, and tool usage should be visible across channels from one control-plane stream.

10. Progressive delivery, no rewrites
    - New capabilities should extend existing contracts.
    - Preserve compatibility and avoid throwing away working foundations.

## Implementation Guardrail

When in doubt:
- keep orchestration decisions in gateway,
- keep execution in workers,
- keep side effects behind typed tools/policies,
- keep user trust via explicit progress and auditable traces.
