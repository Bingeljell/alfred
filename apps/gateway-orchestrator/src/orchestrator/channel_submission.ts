import { z } from "zod";
import { InboundMessageSchema, type InboundMessage } from "../../../../packages/contracts/src";

export const ChannelOriginSchema = z.object({
  channelId: z.string().min(1),
  channelContextId: z.string().min(1),
  provider: z.string().optional(),
  transport: z.string().optional(),
  messageId: z.string().optional(),
  senderId: z.string().optional(),
  senderName: z.string().optional()
});

export type ChannelOrigin = z.infer<typeof ChannelOriginSchema>;

export function withChannelOrigin(inbound: InboundMessage, origin: ChannelOrigin): InboundMessage {
  const metadata = {
    ...(inbound.metadata ?? {}),
    ...(inbound.metadata?.provider ? {} : origin.provider ? { provider: origin.provider } : {}),
    origin
  };
  return {
    ...inbound,
    metadata
  };
}

export function normalizeInboundFromChannel(
  payload: unknown,
  defaults: {
    channelId: string;
    provider?: string;
    transport?: string;
  }
): InboundMessage {
  const inbound = InboundMessageSchema.parse(payload ?? {});
  const rawOrigin =
    inbound.metadata && typeof inbound.metadata === "object" && "origin" in inbound.metadata
      ? ChannelOriginSchema.safeParse((inbound.metadata as Record<string, unknown>).origin)
      : null;
  if (rawOrigin?.success) {
    return withChannelOrigin(inbound, rawOrigin.data);
  }

  const origin: ChannelOrigin = {
    channelId: defaults.channelId,
    channelContextId: inbound.sessionId,
    ...(defaults.provider ? { provider: defaults.provider } : {}),
    ...(defaults.transport ? { transport: defaults.transport } : {})
  };
  return withChannelOrigin(inbound, origin);
}
