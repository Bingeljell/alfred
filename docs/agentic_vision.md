# Agentic Vision (Locked)

## Core Principle

Alfred is an **agentic orchestrator**, not a form-based SaaS command app.

- The user states goals in natural language.
- Alfred clarifies intent, constraints, and success criteria.
- Alfred selects and executes tools on the user's behalf.
- Deterministic systems remain the execution substrate; the LLM is the decision and orchestration layer.

## Architecture Intent

1. **Planner/Orchestrator first**
   - Gateway resolves session context, clarifies ambiguity, plans execution, applies policy, and supervises outcomes.
2. **Tools as deterministic capabilities**
   - Tool interfaces are typed, auditable, and policy-gated.
   - Side effects are explicit and approval-aware.
3. **Skills as behavioral abstractions**
   - Skills guide how Alfred reasons and when to use tools.
   - Skills can include deterministic tool-routing hints, but they are not a replacement for tool contracts.
4. **Workers execute plans**
   - Workers execute RunSpecs and report progress/results.
   - Workers do not own orchestration truth.

## Product Rule

When we add any feature, default to this sequence:

1. Define/extend tool contract.
2. Add policy + approval semantics.
3. Make the planner call the tool from natural language.
4. Keep explicit slash commands as operator/debug fallbacks, not the primary product experience.

## Anti-Pattern to Avoid

- Building large deterministic command trees as the primary UX.
- Treating Alfred as a menu-driven SaaS bot.
- Bypassing planner context in favor of command-only flows for normal user interactions.
