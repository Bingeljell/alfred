export type WhatsAppOutboundMessage = {
  sessionId: string;
  text: string;
  jobId?: string;
  status?: string;
};

export type WhatsAppOutboundFile = {
  sessionId: string;
  filePath: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
};

export interface WhatsAppAdapter {
  readonly name: string;
  sendText(message: WhatsAppOutboundMessage): Promise<void>;
  sendFile?(file: WhatsAppOutboundFile): Promise<void>;
}

export class StdoutWhatsAppAdapter implements WhatsAppAdapter {
  readonly name = "stdout";

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[whatsapp:${message.sessionId}] ${message.text}`);
  }

  async sendFile(file: WhatsAppOutboundFile): Promise<void> {
    const fileLabel = file.fileName ?? file.filePath;
    const caption = file.caption ? ` caption="${file.caption}"` : "";
    // eslint-disable-next-line no-console
    console.log(`[whatsapp:${file.sessionId}] [file:${fileLabel}]${caption}`);
  }
}

export class InMemoryWhatsAppAdapter implements WhatsAppAdapter {
  readonly name = "in-memory";
  readonly sent: WhatsAppOutboundMessage[] = [];
  readonly sentFiles: WhatsAppOutboundFile[] = [];

  async sendText(message: WhatsAppOutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  async sendFile(file: WhatsAppOutboundFile): Promise<void> {
    this.sentFiles.push(file);
  }
}
