import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunSpecV1 } from "../../packages/contracts/src";
import { OutboundNotificationStore } from "../../apps/gateway-orchestrator/src/notification_store";
import { RunSpecStore } from "../../apps/gateway-orchestrator/src/builtins/run_spec_store";
import { executeRunSpec } from "../../apps/worker/src/run_spec_executor";

function makeSpec(runId: string): RunSpecV1 {
  return {
    version: 1,
    id: runId,
    goal: "research and send file",
    metadata: {},
    steps: [
      {
        id: "search",
        type: "web.search",
        name: "Search",
        input: { query: "best test frameworks", provider: "searxng" }
      },
      {
        id: "compose",
        type: "doc.compose",
        name: "Compose",
        input: { query: "best test frameworks", fileFormat: "md" }
      },
      {
        id: "write",
        type: "file.write",
        name: "Write",
        input: { fileFormat: "md", fileName: "frameworks" },
        approval: { required: true, capability: "file_write" }
      },
      {
        id: "send",
        type: "channel.send_attachment",
        name: "Send",
        input: { caption: "Here is your summary" },
        approval: { required: true, capability: "file_write" }
      }
    ]
  };
}

describe("executeRunSpec", () => {
  it("executes a full run and records step status + attachment notification", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-runspec-exec-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const runSpecStore = new RunSpecStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    await fs.mkdir(workspaceDir, { recursive: true });
    await runSpecStore.ensureReady();
    await notificationStore.ensureReady();

    const runId = "run-spec-exec-ok";
    const runSpec = makeSpec(runId);
    await runSpecStore.put({
      runId,
      sessionId: "owner@s.whatsapp.net",
      spec: runSpec,
      status: "running",
      approvedStepIds: ["write", "send"]
    });

    const progressEvents: Array<{ message: string; step?: string; percent?: number }> = [];
    const response = await executeRunSpec({
      runId,
      sessionId: "owner@s.whatsapp.net",
      authSessionId: "owner@s.whatsapp.net",
      authPreference: "auto",
      runSpec,
      approvedStepIds: ["write", "send"],
      workspaceDir,
      webSearchService: {
        search: vi.fn().mockResolvedValue({
          provider: "searxng",
          text: "Option A\nOption B\nSource: https://example.com"
        })
      } as never,
      llmService: {
        generateText: vi.fn().mockResolvedValue({
          text: "# Summary\n\n- Option A\n- Option B"
        })
      } as never,
      notificationStore,
      runSpecStore,
      reportProgress: async (progress) => {
        progressEvents.push(progress);
      }
    });

    expect(response.summary).toBe("run_spec_completed");
    expect(response.outputPath).toContain("notes/generated/frameworks.md");
    expect(progressEvents.some((event) => event.step === "run_spec.completed")).toBe(true);

    const record = await runSpecStore.get(runId);
    expect(record?.status).toBe("completed");
    expect(record?.stepStates.search?.status).toBe("completed");
    expect(record?.stepStates.compose?.status).toBe("completed");
    expect(record?.stepStates.write?.status).toBe("completed");
    expect(record?.stepStates.send?.status).toBe("completed");

    const pending = await notificationStore.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.kind).toBe("file");
    expect(pending[0]?.fileName).toBe("frameworks.md");
    expect(pending[0]?.sessionId).toBe("owner@s.whatsapp.net");

    const written = await fs.readFile(path.join(workspaceDir, "notes", "generated", "frameworks.md"), "utf8");
    expect(written).toContain("Summary");
  });

  it("fails fast when a required approval is missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "alfred-runspec-exec-no-approval-unit-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const runSpecStore = new RunSpecStore(stateDir);
    const notificationStore = new OutboundNotificationStore(stateDir);
    await fs.mkdir(workspaceDir, { recursive: true });
    await runSpecStore.ensureReady();
    await notificationStore.ensureReady();

    const runId = "run-spec-exec-blocked";
    const runSpec = makeSpec(runId);
    await runSpecStore.put({
      runId,
      sessionId: "owner@s.whatsapp.net",
      spec: runSpec,
      status: "running",
      approvedStepIds: []
    });

    const response = await executeRunSpec({
      runId,
      sessionId: "owner@s.whatsapp.net",
      authSessionId: "owner@s.whatsapp.net",
      authPreference: "auto",
      runSpec,
      approvedStepIds: [],
      workspaceDir,
      webSearchService: {
        search: vi.fn().mockResolvedValue({ provider: "searxng", text: "x" })
      } as never,
      llmService: {
        generateText: vi.fn().mockResolvedValue({ text: "x" })
      } as never,
      notificationStore,
      runSpecStore,
      reportProgress: async () => undefined
    });

    expect(response.summary).toBe("run_spec_approval_missing");
    const record = await runSpecStore.get(runId);
    expect(record?.status).toBe("failed");
    expect(record?.stepStates.write?.status).toBe("approval_required");
    const pending = await notificationStore.listPending();
    expect(pending.length).toBe(0);
  });
});
