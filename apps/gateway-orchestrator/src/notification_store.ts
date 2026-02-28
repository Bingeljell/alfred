import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type OutboundNotification = {
  id: string;
  sessionId: string;
  kind?: "text" | "file";
  text?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
  jobId?: string;
  status?: string;
  createdAt: string;
  deliveredAt?: string;
};

export class OutboundNotificationStore {
  private readonly notificationsDir: string;

  constructor(stateDir: string) {
    this.notificationsDir = path.join(stateDir, "notifications");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.notificationsDir, { recursive: true });
  }

  async enqueue(notification: Omit<OutboundNotification, "id" | "createdAt">): Promise<OutboundNotification> {
    await this.ensureReady();
    if (notification.kind === "file") {
      if (!notification.filePath || !notification.filePath.trim()) {
        throw new Error("notification_file_path_required");
      }
    } else if (!notification.text || !notification.text.trim()) {
      throw new Error("notification_text_required");
    }

    const full: OutboundNotification = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...notification
    };

    await this.write(full);
    return full;
  }

  async listPending(): Promise<OutboundNotification[]> {
    await this.ensureReady();
    const files = await fs.readdir(this.notificationsDir);
    const items: OutboundNotification[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const raw = await fs.readFile(path.join(this.notificationsDir, file), "utf8");
      const parsed = JSON.parse(raw) as OutboundNotification;
      if (parsed.kind !== "file" && parsed.kind !== "text") {
        parsed.kind = "text";
      }
      if (!parsed.deliveredAt) {
        items.push(parsed);
      }
    }

    return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async markDelivered(id: string): Promise<void> {
    const item = await this.read(id);
    if (!item) {
      return;
    }

    await this.write({
      ...item,
      deliveredAt: new Date().toISOString()
    });
  }

  private filePath(id: string): string {
    return path.join(this.notificationsDir, `${id}.json`);
  }

  private async read(id: string): Promise<OutboundNotification | null> {
    const filePath = this.filePath(id);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as OutboundNotification;
    } catch {
      return null;
    }
  }

  private async write(notification: OutboundNotification): Promise<void> {
    const destination = this.filePath(notification.id);
    const temp = `${destination}.tmp`;
    await fs.writeFile(temp, JSON.stringify(notification, null, 2), "utf8");
    await fs.rename(temp, destination);
  }
}
