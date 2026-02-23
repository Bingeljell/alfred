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
    expect(html).toContain("/v1/auth/openai/disconnect");
    expect(html).toContain("Job Controls");
    expect(html).toContain("OAuth (OpenAI)");
  });
});
