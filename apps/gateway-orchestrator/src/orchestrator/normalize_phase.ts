import { InboundMessageSchema } from "../../../../packages/contracts/src";
import type { NormalizedInboundContext } from "./types";

export function runNormalizePhase(payload: unknown): NormalizedInboundContext {
  const inbound = InboundMessageSchema.parse(payload ?? {});
  const provider = String(inbound.metadata?.provider ?? "");
  const origin =
    inbound.metadata && typeof inbound.metadata === "object" && "origin" in inbound.metadata && inbound.metadata.origin
      ? (inbound.metadata.origin as Record<string, unknown>)
      : undefined;
  const channelId = typeof origin?.channelId === "string" ? origin.channelId.trim().toLowerCase() : "";
  const transport = typeof origin?.transport === "string" ? origin.transport.trim().toLowerCase() : "";
  const isWhatsAppOrigin = channelId === "whatsapp" || provider === "baileys" || transport === "baileys";
  const source = isWhatsAppOrigin ? "whatsapp" : "gateway";
  const channel = isWhatsAppOrigin ? "baileys" : "direct";

  return {
    inbound,
    provider,
    source,
    channel
  };
}
