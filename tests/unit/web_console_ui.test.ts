import { describe, expect, it } from "vitest";
import { renderWebConsoleHtml } from "../../apps/gateway-orchestrator/src/ui/render_web_console";

describe("renderWebConsoleHtml", () => {
  it("renders core sections and endpoint usage hints", () => {
    const html = renderWebConsoleHtml();

    expect(html).toContain("Alfred Test Console");
    expect(html).toContain("/v1/messages/inbound");
    expect(html).toContain("/v1/whatsapp/baileys/inbound");
    expect(html).toContain("/v1/memory/search");
    expect(html).toContain("/v1/auth/openai/start");
    expect(html).toContain("/v1/auth/openai/status");
    expect(html).toContain("/v1/auth/openai/rate-limits");
    expect(html).toContain("/v1/auth/openai/disconnect");
    expect(html).toContain("/v1/whatsapp/live/status");
    expect(html).toContain("/v1/whatsapp/live/connect");
    expect(html).toContain("/v1/whatsapp/live/disconnect");
    expect(html).toContain("Job Controls");
    expect(html).toContain("OAuth (OpenAI)");
    expect(html).toContain("Live WhatsApp (Baileys)");
    expect(html).toContain("WhatsApp Setup Flow");
    expect(html).toContain("id=\"waLiveBadge\"");
    expect(html).toContain("id=\"waSetupNext\"");
    expect(html).toContain("id=\"waCopyEnv\"");
    expect(html).toContain("WHATSAPP_PROVIDER=baileys");
    expect(html).toContain("SEND_CHAT_REQUEST");
    expect(html).toContain(".status[data-state=\"busy\"]");
    expect(html).toContain("id=\"logNewestFirst\"");
    expect(html).toContain("Newest first");
    expect(html).toContain("id=\"authSummary\"");
    expect(html).toContain("id=\"waLiveSummary\"");
    expect(html).toContain("runButtonAction");
  });
});
