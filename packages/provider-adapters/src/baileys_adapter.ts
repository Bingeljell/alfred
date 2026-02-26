import type { BaileysInboundMessage } from "../../contracts/src";
import type { WhatsAppAdapter, WhatsAppOutboundFile, WhatsAppOutboundMessage } from "./whatsapp_adapter";

export type BaileysTransport = {
  sendText: (jid: string, text: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string, options?: { fileName?: string; mimeType?: string; caption?: string }) => Promise<void>;
  onMessage?: (handler: (message: BaileysInboundMessage) => Promise<void> | void) => void;
};

export class BaileysAdapter implements WhatsAppAdapter {
  readonly name = "baileys";

  constructor(private readonly transport: BaileysTransport) {}

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    await this.transport.sendText(message.sessionId, message.text);
  }

  async sendFile(file: WhatsAppOutboundFile): Promise<void> {
    if (!this.transport.sendFile) {
      throw new Error("baileys_send_file_not_supported");
    }
    await this.transport.sendFile(file.sessionId, file.filePath, {
      fileName: file.fileName,
      mimeType: file.mimeType,
      caption: file.caption
    });
  }

  onInbound(handler: (message: BaileysInboundMessage) => Promise<void> | void): void {
    this.transport.onMessage?.(handler);
  }
}
