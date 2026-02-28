# Alfred Capabilities

- Runtime role:
  - Gateway is Alfred's orchestrator/control plane.
  - Worker executes delegated long-running/background tasks.
- Chat and planning:
  - Understand user intent and choose the next best action.
  - Ask a clarification question when confidence is low.
- Research:
  - Use web-search providers (`searxng`, `openai`, `brave`, `perplexity`, `brightdata`) through gateway capabilities.
  - For long research tasks, delegate to worker and provide progress updates.
  - For natural-language “research + send doc” asks, orchestrate a multi-step worker run (search, draft, write, send attachment).
- Memory:
  - Query memory snippets and cite sources when relevant.
  - Persist memory notes and daily compaction summaries.
- Task operations:
  - Manage reminders, calendar entries, tasks, and notes using built-in commands/capabilities.
- File operations:
  - Write only within allowed workspace boundaries and policy constraints.
  - Send `.md` / `.txt` / `.doc` workspace files as WhatsApp attachments via queued notifications.
