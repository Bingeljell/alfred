import { BaileysInboundMessageSchema, type InboundMessage } from "../../../../packages/contracts/src";

export type NormalizedBaileysMessage = {
  dedupeKey: string;
  providerMessageId: string;
  normalized: InboundMessage;
};

function extractText(parsed: ReturnType<typeof BaileysInboundMessageSchema.parse>): string {
  const fromConversation = parsed.message?.conversation?.trim();
  if (fromConversation) {
    return fromConversation;
  }

  const fromExtended = parsed.message?.extendedTextMessage?.text?.trim();
  if (fromExtended) {
    return fromExtended;
  }

  return "";
}

export function normalizeBaileysInbound(payload: unknown): NormalizedBaileysMessage {
  const parsed = BaileysInboundMessageSchema.parse(payload);
  const text = extractText(parsed);
  const wantsJob = text.toLowerCase().startsWith("/job ");

  return {
    dedupeKey: `baileys:${parsed.key.remoteJid}:${parsed.key.id}`,
    providerMessageId: parsed.key.id,
    normalized: {
      sessionId: parsed.key.remoteJid,
      text: wantsJob ? text.slice(5).trim() : text,
      requestJob: wantsJob,
      metadata: {
        provider: "baileys",
        pushName: parsed.pushName,
        messageTimestamp: parsed.messageTimestamp
      }
    }
  };
}
