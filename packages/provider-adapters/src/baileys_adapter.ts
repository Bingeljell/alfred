import type { BaileysInboundMessage } from "../../contracts/src";
import type { WhatsAppAdapter, WhatsAppOutboundMessage } from "./whatsapp_adapter";

export type BaileysTransport = {
  sendText: (jid: string, text: string) => Promise<void>;
  onMessage?: (handler: (message: BaileysInboundMessage) => Promise<void> | void) => void;
};

export class BaileysAdapter implements WhatsAppAdapter {
  readonly name = "baileys";

  constructor(private readonly transport: BaileysTransport) {}

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    await this.transport.sendText(message.sessionId, message.text);
  }

  onInbound(handler: (message: BaileysInboundMessage) => Promise<void> | void): void {
    this.transport.onMessage?.(handler);
  }
}
