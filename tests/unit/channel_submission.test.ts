import { describe, expect, it } from "vitest";
import {
  normalizeInboundFromChannel,
  withChannelOrigin
} from "../../apps/gateway-orchestrator/src/orchestrator/channel_submission";

describe("channel_submission", () => {
  it("applies default origin metadata for web channel submissions", () => {
    const inbound = normalizeInboundFromChannel(
      {
        sessionId: "owner@s.whatsapp.net",
        text: "hello"
      },
      {
        channelId: "web",
        provider: "gateway-http",
        transport: "http"
      }
    );

    expect(inbound.metadata?.provider).toBe("gateway-http");
    expect(inbound.metadata?.origin).toEqual({
      channelId: "web",
      channelContextId: "owner@s.whatsapp.net",
      provider: "gateway-http",
      transport: "http"
    });
  });

  it("preserves an explicit origin if one is already present", () => {
    const inbound = normalizeInboundFromChannel(
      {
        sessionId: "owner@s.whatsapp.net",
        text: "hello",
        metadata: {
          provider: "baileys",
          origin: {
            channelId: "whatsapp",
            channelContextId: "owner@s.whatsapp.net",
            provider: "baileys",
            transport: "baileys"
          }
        }
      },
      {
        channelId: "web",
        provider: "gateway-http",
        transport: "http"
      }
    );

    expect(inbound.metadata?.provider).toBe("baileys");
    expect((inbound.metadata?.origin as { channelId: string }).channelId).toBe("whatsapp");
  });

  it("adds provider only when missing", () => {
    const withProvider = withChannelOrigin(
      {
        sessionId: "owner@s.whatsapp.net",
        text: "hello",
        requestJob: false,
        metadata: {
          provider: "baileys"
        }
      },
      {
        channelId: "whatsapp",
        channelContextId: "owner@s.whatsapp.net",
        provider: "gateway-http",
        transport: "http"
      }
    );

    expect(withProvider.metadata?.provider).toBe("baileys");
  });
});
