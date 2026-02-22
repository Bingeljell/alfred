export type WhatsAppOutboundMessage = {
  sessionId: string;
  text: string;
  jobId?: string;
  status?: string;
};

export interface WhatsAppAdapter {
  readonly name: string;
  sendText(message: WhatsAppOutboundMessage): Promise<void>;
}

export class StdoutWhatsAppAdapter implements WhatsAppAdapter {
  readonly name = "stdout";

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[whatsapp:${message.sessionId}] ${message.text}`);
  }
}

export class InMemoryWhatsAppAdapter implements WhatsAppAdapter {
  readonly name = "in-memory";
  readonly sent: WhatsAppOutboundMessage[] = [];

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}
