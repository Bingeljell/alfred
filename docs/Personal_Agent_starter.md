# Personal Agent — Idea Doc (WhatsApp-first, Secure, Skill-Based)

**Owner:** Nikhil Shahane  
**Date:** 2026-02-22  
**Status:** Draft / Working Notes

---

## 0) One-paragraph summary

Build a **WhatsApp-first personal agent** that can **do real tasks** via **installable, permissioned skills** (e.g., video editing, writing, business ops). A **Master Agent** routes requests to **sub-agents** (each with its own **personality** and **skillset**). Skills are packaged outside the core agent (separate repos/artifacts), run **in a sandbox per job**, and produce **auditable receipts**. Users can bring their own LLM connection (OpenAI OAuth, API keys, local models). The goal is **autonomy + real value** without becoming a “general insecure self-hacking computer.”

---

## 1) Problem & Motivation

### Motivation
- Existing general agents (e.g., OpenClaw-like systems) can be powerful but feel:
  - **too broad / too much happening**
  - **tech-savvy-first** (unsafe unless you know what you’re doing)
- Nikhil already has **CLI-first tools** (e.g., quick-and-dirty video editor) that deliver value.
- Desire: a system that is **more secure**, **simpler**, and **task-capable**, while enabling:
  - **open-source extensibility**
  - **multiple “specialist” agents** with distinct personalities

### Key value proposition
- A simple chat interface (primarily WhatsApp) that:
  - performs concrete tasks (not just chat)
  - supports specialized “souls” for better outputs
  - can be extended by community-built skills

---

## 2) Product Goals (What “success” looks like)

### Must-haves
- **WhatsApp-first** interaction (remote-first), plus optional **terminal** and **desktop app** later.
- **Real tasks** via skills: video edits, writing, business ops automations, etc.
- **Bring-your-own LLM**: OpenAI OAuth, API key, or local.
- **Installable skills** that are versioned and usable outside the agent as well.
- **Security by design**: least privilege, sandbox execution, audit trail.

### Nice-to-haves
- “Self-improving” behavior via:
  - better prompts, routing rules, and workflows/macros
  - *human-gated* updates for trusted code/skills (PRs / signed releases)

### Non-goals (initially)
- Fully general “do anything on my computer” agent.
- Custom UI for each interaction type (keep it chat-first).

---

## 3) Core Concepts & Terminology

### Orchestrator (Core Runtime / Harness)
A stable, boring system responsible for:
- WhatsApp gateway + message routing
- user identity and sessions
- secrets handling (LLM credentials, integrations)
- job queue + artifact storage (files in/out)
- policy enforcement (permissions, timeouts, egress control)
- skill registry / installation manager
- receipts + audit logs

> Principle: **Orchestrator does not run arbitrary shell or browse directly.** It only invokes skills through a controlled interface.

### Master Agent (Dispatcher)
- Receives user requests, interprets intent, chooses:
  - which sub-agent persona to activate
  - which skills are required
  - what permissions are needed
- Coordinates confirmations and returns outputs.

### Sub-agents (Specialists with “SOUL”)
- Each has distinct personality, tone, and focus.
- Examples:
  - **Video Editing Agent**
  - **Writing Agent** (personality + “SOUL”)
  - **Business Ops Agent**
  - **Research Agent**
- Operate on a **job** basis: wake up, load relevant context, plan, call skills, return result.

### Skills (Installable Capabilities)
- Live in separate repos/artifacts.
- Expose typed tools (functions) like:
  - `clip_video`, `crop_video`, `denoise_audio`, `compress_for_whatsapp`
- Declare required permissions (fs/network/cpu/time).
- Run inside sandboxed runtime (container/VM/WASM).
- Can be used by the agent OR independently.

### Tools / CLI Toolkits
- Powerful underlying CLIs (e.g., video processing) are packaged behind skill APIs.
- Goal: agent calls **typed tools**, not raw shell.

---

## 4) Example User Flows

### A) WhatsApp video edit (simple)
1. User sends video + message: “Crop to 1:1 and fade out.”
2. Master Agent routes to Video Agent.
3. Orchestrator:
   - stores media as an input artifact
   - spins up sandbox job for video skill
4. Video skill produces output video.
5. Agent sends edited video back + a receipt.

### B) Video edit from cloud link
1. User: “Here’s a Google Drive link. Denoise and compress.”
2. System uses a “cloud fetch” skill (or connector) with limited permissions.
3. Video skill processes output.
4. Output is uploaded to storage or sent via WhatsApp.

### C) Business ops proposal
1. User: “Build a proposal for Client X; here’s context.”
2. Routes to Business Ops Agent.
3. Uses proposal builder skill (CLI or external service) to generate:
   - doc or shareable link
   - analytics/tracking if supported
4. Returns proposal + receipt.

---

## 5) Autonomy vs Security (Key tension + proposed approach)

### Desired autonomy
- Agent can do tasks and “improve” over time.

### Security risk
- Self-modifying core + arbitrary tool installs → supply-chain risks and takeover.

### Working direction (proposed)
Two-track approach:
- **Safe autonomy (always-on):** prompt improvements, workflow generation, routing heuristics, skill suggestions.
- **Trusted updates (human-gated):** PRs/signed releases for core code or privileged skills.

> Mantra: **The agent can write code, but only the pipeline ships code.**

---

## 6) Security Principles (initial)

- **Least privilege**: skills request only what they need.
- **No arbitrary shell tool** exposed to agents.
- **Sandbox per job** (ephemeral), not long-lived shared runtime.
- **Network default deny**. Allowlist per skill where needed.
- **Immutable skill artifacts** (pin by digest; signed builds preferred).
- **Receipts for everything**:
  - inputs/outputs
  - tool calls
  - execution logs
  - time/cost metadata
- **Human-in-the-loop gates** for high-risk actions:
  - payments/purchases (“order food”)
  - login flows / account linking
  - destructive actions

---

## 7) “General-purpose” tasks (browser/research) without losing safety

Treat “general” capabilities as **skills too**, each with explicit risk profiles:

- **Research skill:** web read-only, allowlisted domains, outputs citations/summaries.
- **Browser automation skill (highest risk):** isolated remote browser (Playwright), recorded sessions, confirmation at checkout/login.
- **Video skill:** high CPU, no network, strict file IO.
- **Ops skill:** network allowlist to specific SaaS APIs/services, strong token scoping.

Routing becomes: **request → risk level → agent + skill set**.

---

## 8) Memory Design (proposed starting point)

### Desired
- Permanent memory via storing interactions in markdown.
- Summaries stored periodically for quick recall.
- Optional vector DB later.

### Proposed minimal structure
- `memory/YYYY-MM-DD.md` — day-wise interactions + extracted facts
- `memory/weekly/YYYY-WW.md` — weekly summary highlights
- `memory/profile.md` — stable user preferences & “facts to remember”

Notes:
- Memory should be maintained by orchestrator services.
- Retrieval can be a “memory read” skill (read-only, query-based).
- Sensitive memory updates can be user-confirmed.

Open question: whether to store “raw logs” vs “structured events” + derived markdown.

---

## 9) Personalities (“SOUL.md”)

- Each agent has a `SOUL.md` defining:
  - voice and tone
  - values/priorities
  - how it collaborates with the master agent and user
- Keep **hard policies separate** (e.g., `POLICY.md`) to prevent personality from granting capabilities.

---

## 10) What we need to build (high-level components)

### A) WhatsApp gateway
- WhatsApp Cloud API or Twilio WhatsApp integration
- media handling (upload/download, size constraints)
- message retries / webhooks

### B) Orchestration harness
- job queue
- artifact store
- skill runner interface (the only execution path)

### C) Sandbox runner
- execute skill runtimes in isolated environments
- enforce timeouts, memory, CPU
- mount controlled file inputs/outputs
- control network egress (deny by default)

### D) Skill packaging & installation
- registry concept
- allowlists
- versioning & pinning by digest
- signatures/attestations (later)

### E) LLM provider abstraction
- OAuth + API keys + local model options
- per-user credential storage
- usage/cost tracking

### F) Receipts + audit
- standard format
- storage + retrieval
- user-visible summary after each task

---

## 11) Open-ended points & technical questions (to decide)

### Architecture & runtime
1. **Orchestration**: what should run jobs?
   - Options: simple worker queue (Redis + workers), Temporal, BullMQ, Celery, etc.
2. **Sandbox**: what’s the isolation strategy?
   - Options: Docker only, Docker + gVisor, Firecracker microVMs, WASM/WASI.
3. **Artifact storage**:
   - local filesystem vs S3-compatible object store.
4. **Skill distribution**:
   - GitHub repos? OCI registry? signed tarballs?
   - How to define “trusted sources” for installs?

### WhatsApp & UX
5. WhatsApp provider choice:
   - Meta Cloud API vs Twilio WhatsApp.
6. Media constraints:
   - WhatsApp video size limits and compression targets (define presets).
7. Receipts UX:
   - How verbose should receipts be in chat?
   - Where do detailed logs live?

### LLM connectivity
8. **OpenAI OAuth**:
   - feasibility and best approach for “Plus plan” access (confirm capability).
9. Provider abstraction:
   - how to support multiple LLMs cleanly (OpenAI, Anthropic, local, etc.)
10. Data handling & privacy:
   - what is stored, for how long, and how users can delete/export.

### Skills & permissions
11. **Permissions model**:
   - filesystem scopes (read/write)
   - network allowlists
   - time/memory caps
   - external messaging permissions (email/webhook/etc.)
12. **Tool schemas**:
   - how strict to be? JSON schema? protobuf? OpenAPI-ish?
13. **Skill safety**:
   - how to prevent “skill escape” (network/file restrictions, runtime confinement)
14. **Sub-agent composition**:
   - can skills call other skills? Or only orchestrator can chain?

### Memory
15. Markdown vs structured storage:
   - events db + markdown derived vs markdown as source of truth.
16. Summarization cadence:
   - daily summaries, weekly highlights, “profile” updates.
17. Vector DB:
   - when to introduce, and what embeddings provider.

### Browser automation
18. Research vs automation separation:
   - read-only browsing skill vs interactive automation skill.
19. Human-in-the-loop gates:
   - what requires explicit user confirmation?
20. Credential handling:
   - do we ever store site credentials, or only use OAuth connectors?

---

## 12) Key principles to prevent “repo sprawl” (like OpenClaw)

- Keep the **core minimal** and stable.
- Push all capability into **skills** with explicit permissions.
- Treat “general browsing/automation” as high-risk skills with strict gating.
- Use **typed tools** instead of arbitrary command execution.
- Make everything produce a **receipt**.

---

## 13) Next steps (discussion-oriented)

1. Decide sandbox baseline: containers-only vs containers + gVisor.
2. Define the “skill contract” fields at a high level (without implementation).
3. Choose the initial 2–3 skills to build for real value:
   - Video editing
   - Proposal builder / business ops
   - Writing agent (persona-driven, low-risk tools)
4. Define the minimal receipt format users will see in chat.
5. Clarify what “OpenAI Plus via OAuth” realistically means for the product plan.

---

**End of doc**
