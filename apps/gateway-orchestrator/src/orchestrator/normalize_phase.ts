import { InboundMessageSchema } from "../../../../packages/contracts/src";
import type { NormalizedInboundContext } from "./types";

export function runNormalizePhase(payload: unknown): NormalizedInboundContext {
  const inbound = InboundMessageSchema.parse(payload ?? {});
  const provider = String(inbound.metadata?.provider ?? "");
  const source = provider === "baileys" ? "whatsapp" : "gateway";
  const channel = provider === "baileys" ? "baileys" : "direct";

  return {
    inbound,
    provider,
    source,
    channel
  };
}

