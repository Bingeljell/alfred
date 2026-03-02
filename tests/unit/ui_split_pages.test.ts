import { describe, expect, it } from "vitest";
import { renderUiHomeHtml } from "../../apps/gateway-orchestrator/src/ui/render_ui_home";
import { renderUiTranscriptsHtml } from "../../apps/gateway-orchestrator/src/ui/render_ui_transcripts";
import { renderUiWorkspaceHtml } from "../../apps/gateway-orchestrator/src/ui/render_ui_workspace";

describe("ui split pages", () => {
  it("renders dashboard page with status cards and binding controls", () => {
    const html = renderUiHomeHtml();
    expect(html).toContain("Alfred Dashboard");
    expect(html).toContain("Source Status");
    expect(html).toContain("Identity Bindings");
    expect(html).toContain("id=\"gatewayCard\"");
    expect(html).toContain("id=\"authCard\"");
    expect(html).toContain("id=\"waCard\"");
    expect(html).toContain("id=\"memoryCard\"");
    expect(html).toContain("id=\"mapBind\"");
    expect(html).toContain("id=\"mapResolve\"");
    expect(html).toContain("id=\"mapList\"");
    expect(html).toContain("href=\"/ui/transcripts\"");
    expect(html).toContain("href=\"/ui/workspace\"");
    expect(html).toContain("href=\"/ui/console\"");
  });

  it("renders transcripts page with filters and stream API usage", () => {
    const html = renderUiTranscriptsHtml();
    expect(html).toContain("Alfred Transcripts");
    expect(html).toContain("id=\"sessionId\"");
    expect(html).toContain("id=\"transcriptDate\"");
    expect(html).toContain("id=\"allSessions\"");
    expect(html).toContain("id=\"refreshBtn\"");
    expect(html).toContain("id=\"toggleAuto\"");
    expect(html).toContain("id=\"transcript\"");
    expect(html).toContain("selectionPauseUntil");
    expect(html).toContain("user-select: text;");
    expect(html).toContain("/v1/stream/events");
    expect(html).toContain("limit=500");
    expect(html).toContain("href=\"/ui\"");
    expect(html).toContain("href=\"/ui/workspace\"");
    expect(html).toContain("href=\"/ui/console\"");
  });

  it("renders workspace page with sessions, chat, and trace panes", () => {
    const html = renderUiWorkspaceHtml();
    expect(html).toContain("Alfred Workspace");
    expect(html).toContain("id=\"sessionList\"");
    expect(html).toContain("id=\"runList\"");
    expect(html).toContain("id=\"chatLog\"");
    expect(html).toContain("id=\"eventLog\"");
    expect(html).toContain("id=\"approvals\"");
    expect(html).toContain("id=\"artifacts\"");
    expect(html).toContain("/v1/agent/sessions");
    expect(html).toContain("/v1/agent/runs");
    expect(html).toContain("/v1/approvals/pending");
    expect(html).toContain("/v1/messages/inbound");
    expect(html).toContain("href=\"/ui\"");
    expect(html).toContain("href=\"/ui/transcripts\"");
    expect(html).toContain("href=\"/ui/console\"");
  });
});
