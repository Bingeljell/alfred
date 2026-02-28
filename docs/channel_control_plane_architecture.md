# Channel Control-Plane Architecture (Locked)

## Purpose

Define a non-negotiable architecture rule for Alfred:

- Channels (WhatsApp, Web, TUI, future Telegram) are **input/output lanes only**.
- All orchestration logic starts at the **gateway control plane**.

No channel adapter is allowed to implement planner logic, policy logic, memory logic, or provider-specific reasoning.

## Core Rule

For every inbound message:

1. Channel adapter ingests transport payload.
2. Adapter authenticates sender and resolves channel context.
3. Adapter submits a normalized turn to gateway internal API.
4. Gateway runs full turn state machine:
   - normalize -> session -> directives -> plan -> policy -> route -> persist -> dispatch
5. Gateway delegates long/background work to worker.
6. Adapter only streams/sends gateway outputs back to channel.

## Channel Responsibilities (Thin Adapters)

Allowed in adapters:

- transport connect/reconnect
- sender allowlist/auth checks
- channel-context derivation (chat, thread/topic, participant scope)
- command interception for transport-level controls (`/new`, `/switch`, `/status`, `/cancel`)
- attachment download/upload with bounded limits
- submit turn + receive stream updates

Not allowed in adapters:

- planner decisions
- capability/approval policy evaluation
- memory retrieval/compaction decisions
- provider/model fallback logic
- orchestration retries/repair loops

## WhatsApp Mapping (Reference Flow)

1. Boot wiring
   - Runtime starts WhatsApp adapter only when configured.
2. Adapter startup
   - Baileys event loop and per-message handler fan-in.
3. Sender auth (default deny)
   - Unknown senders dropped and audited.
4. Context identity
   - `channel_context_id` derives from chat JID / group+participant scope.
5. Session mapping
   - `(channel_id=whatsapp, channel_context_id) -> session_id` via persistent mapping store.
6. Command interception
   - transport-level control commands handled before gateway turn submit.
7. Attachment ingress
   - download, bound (size/count), normalize to inline media.
8. Gateway submission
   - submit normalized turn with origin metadata.
9. Runtime execution
   - unified gateway/worker loop (same as web/TUI).
10. Streaming response
   - sparse progress + final message strategy (no edit-message capability assumption).
11. Outbound media
   - send generated attachments via WhatsApp adapter.
12. Proactive notifications
   - gateway routes by origin channel + channel context.

## Why This Is Locked

- Keeps orchestration behavior identical across channels.
- Prevents channel-specific logic drift.
- Preserves auditable policy and approval enforcement in one place.
- Enables future channels without runtime rewrites.

## Implementation Constraints

- Gateway owns canonical session/run state.
- Worker executes delegated tasks; does not own orchestration truth.
- All tool calls and side effects must be visible in control-plane telemetry.
- Channel adapters remain stateless/thin wherever possible.
