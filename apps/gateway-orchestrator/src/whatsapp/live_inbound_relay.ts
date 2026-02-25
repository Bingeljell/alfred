import type { BaileysInboundMessage } from "../../../../packages/contracts/src";

type ChatReplyTransport = {
  sendText: (jid: string, text: string) => Promise<void>;
};

function isValidJid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.endsWith("@s.whatsapp.net") || value.endsWith("@lid"))
  );
}

export async function maybeSendBaileysChatReply(
  transport: ChatReplyTransport,
  inboundPayload: BaileysInboundMessage,
  inboundResult: unknown
): Promise<void> {
  if (!inboundResult || typeof inboundResult !== "object") {
    return;
  }

  const result = inboundResult as Record<string, unknown>;
  if (result.mode !== "chat") {
    return;
  }

  const responseText = typeof result.response === "string" ? result.response.trim() : "";
  if (!responseText) {
    return;
  }

  const remoteJid = inboundPayload?.key?.remoteJid;
  if (!isValidJid(remoteJid)) {
    return;
  }

  await transport.sendText(remoteJid, responseText);
}
