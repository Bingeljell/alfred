import fs from "node:fs/promises";
import path from "node:path";
import type { BaileysInboundMessage } from "../../../../packages/contracts/src";
import type { BaileysTransport } from "../../../../packages/provider-adapters/src";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
type InboundSyncState = "bootstrapping" | "live";

const MAX_SEEN_MESSAGE_KEYS = 5000;

type BaileysRuntimeStatus = {
  provider: "baileys";
  state: ConnectionState;
  connected: boolean;
  meId: string | null;
  qr: string | null;
  qrUpdatedAt: string | null;
  qrGenerationCount: number;
  qrGenerationLimit: number;
  qrLocked: boolean;
  lastDisconnectCode: number | null;
  lastDisconnectReason: string | null;
  lastError: string | null;
  inboundSyncState: InboundSyncState;
  inboundLiveAt: string | null;
  acceptedMessageCount: number;
  ignoredNonNotifyCount: number;
  ignoredPreLiveCount: number;
  ignoredStaleCount: number;
  ignoredDuplicateCount: number;
  ignoredUnsupportedJidCount: number;
  ignoredFromMeCount: number;
  ignoredSenderNotAllowedCount: number;
  ignoredMissingPrefixCount: number;
  updatedAt: string;
};

type BaileysSocket = {
  ev: {
    on: (event: string, listener: (payload: unknown) => void) => void;
  };
  sendMessage: (jid: string, payload: Record<string, unknown>) => Promise<void>;
  end?: (error?: unknown) => void;
  logout?: () => Promise<void>;
  user?: {
    id?: string;
  };
};

type BaileysModule = {
  default: (options: Record<string, unknown>) => BaileysSocket;
  fetchLatestBaileysVersion: () => Promise<{ version: [number, number, number] }>;
  useMultiFileAuthState: (directory: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
};

function defaultModuleLoader(): Promise<BaileysModule> {
  return import("@whiskeysockets/baileys") as unknown as Promise<BaileysModule>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractMessageText(message: Record<string, unknown> | null | undefined): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const conversation = typeof message.conversation === "string" ? message.conversation.trim() : "";
  if (conversation) {
    return conversation;
  }

  const extendedTextMessage =
    "extendedTextMessage" in message && message.extendedTextMessage && typeof message.extendedTextMessage === "object"
      ? (message.extendedTextMessage as Record<string, unknown>)
      : null;

  const extendedText = typeof extendedTextMessage?.text === "string" ? extendedTextMessage.text.trim() : "";
  if (extendedText) {
    return extendedText;
  }

  return "";
}

function isAllowedRemoteJid(remoteJid: string): boolean {
  return remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
}

function canonicalSenderKey(remoteJid: string): string {
  const base = remoteJid.trim().toLowerCase();
  if (!base) {
    return "";
  }
  const at = base.indexOf("@");
  const left = at >= 0 ? base.slice(0, at) : base;
  const user = left.split(":")[0]?.trim() ?? "";
  return user;
}

function safeDisconnectCode(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const lastDisconnect = "lastDisconnect" in payload ? payload.lastDisconnect : null;
  if (!lastDisconnect || typeof lastDisconnect !== "object") {
    return null;
  }

  const error = "error" in lastDisconnect ? lastDisconnect.error : null;
  if (!error || typeof error !== "object") {
    return null;
  }

  const output = "output" in error ? error.output : null;
  if (output && typeof output === "object") {
    const statusCode = "statusCode" in output ? output.statusCode : null;
    if (typeof statusCode === "number") {
      return statusCode;
    }

    const outputPayload = "payload" in output ? output.payload : null;
    if (outputPayload && typeof outputPayload === "object") {
      const payloadStatusCode = "statusCode" in outputPayload ? outputPayload.statusCode : null;
      if (typeof payloadStatusCode === "number") {
        return payloadStatusCode;
      }
    }
  }

  const data = "data" in error ? error.data : null;
  if (data && typeof data === "object") {
    const attrs = "attrs" in data ? data.attrs : null;
    if (attrs && typeof attrs === "object") {
      const code = "code" in attrs ? attrs.code : null;
      if (typeof code === "number" && Number.isFinite(code)) {
        return Math.trunc(code);
      }
      if (typeof code === "string") {
        const parsed = Number(code);
        if (Number.isFinite(parsed)) {
          return Math.trunc(parsed);
        }
      }
    }
  }

  return null;
}

function safeDisconnectReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const lastDisconnect = "lastDisconnect" in payload ? payload.lastDisconnect : null;
  if (!lastDisconnect || typeof lastDisconnect !== "object") {
    return null;
  }

  const error = "error" in lastDisconnect ? lastDisconnect.error : null;
  if (!error || typeof error !== "object") {
    return null;
  }

  const message = "message" in error ? error.message : null;
  return typeof message === "string" ? message : null;
}

function safeMessageTimestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    }
  }

  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    }
  }

  return null;
}

export class BaileysRuntime implements BaileysTransport {
  private readonly authDir: string;
  private readonly onInbound: (message: BaileysInboundMessage) => Promise<void>;
  private readonly maxTextChars: number;
  private readonly reconnectDelayMs: number;
  private readonly maxQrGenerations: number;
  private readonly allowSelfFromMe: boolean;
  private readonly requirePrefix?: string;
  private readonly historyGraceWindowSec: number;
  private readonly allowedSenders: Set<string>;
  private readonly loadModule: () => Promise<BaileysModule>;

  private socket: BaileysSocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private allowReconnect = true;
  private inboundHandler: ((message: BaileysInboundMessage) => Promise<void> | void) | null = null;
  private liveSinceUnixSec: number | null = null;
  private readonly seenMessageKeys = new Set<string>();

  private statusValue: BaileysRuntimeStatus = {
    provider: "baileys",
    state: "disconnected",
    connected: false,
    meId: null,
    qr: null,
    qrUpdatedAt: null,
    qrGenerationCount: 0,
    qrGenerationLimit: 3,
    qrLocked: false,
    lastDisconnectCode: null,
    lastDisconnectReason: null,
    lastError: null,
    inboundSyncState: "bootstrapping",
    inboundLiveAt: null,
    acceptedMessageCount: 0,
    ignoredNonNotifyCount: 0,
    ignoredPreLiveCount: 0,
    ignoredStaleCount: 0,
    ignoredDuplicateCount: 0,
    ignoredUnsupportedJidCount: 0,
    ignoredFromMeCount: 0,
    ignoredSenderNotAllowedCount: 0,
    ignoredMissingPrefixCount: 0,
    updatedAt: nowIso()
  };

  constructor(options: {
    authDir: string;
    onInbound: (message: BaileysInboundMessage) => Promise<void>;
    maxTextChars?: number;
    reconnectDelayMs?: number;
    maxQrGenerations?: number;
    allowSelfFromMe?: boolean;
    requirePrefix?: string;
    historyGraceWindowSec?: number;
    allowedSenders?: string[];
    moduleLoader?: () => Promise<BaileysModule>;
  }) {
    this.authDir = options.authDir;
    this.onInbound = options.onInbound;
    this.maxTextChars = options.maxTextChars ?? 4000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.maxQrGenerations = options.maxQrGenerations ?? 3;
    this.allowSelfFromMe = options.allowSelfFromMe ?? false;
    this.requirePrefix = options.requirePrefix?.trim() || undefined;
    this.historyGraceWindowSec = Math.max(0, options.historyGraceWindowSec ?? 90);
    this.allowedSenders = new Set(
      (options.allowedSenders ?? [])
        .map((item) => canonicalSenderKey(item))
        .filter((item) => item.length > 0)
    );
    this.loadModule = options.moduleLoader ?? defaultModuleLoader;
    this.updateStatus({
      qrGenerationLimit: this.maxQrGenerations
    });
  }

  status(): BaileysRuntimeStatus {
    return { ...this.statusValue };
  }

  async connect(): Promise<BaileysRuntimeStatus> {
    this.allowReconnect = true;
    if (this.connectPromise) {
      await this.connectPromise;
      return this.status();
    }
    this.clearReconnectTimer();

    this.connectPromise = this.connectInternal();
    try {
      await this.connectPromise;
      return this.status();
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(options?: { logout?: boolean }): Promise<BaileysRuntimeStatus> {
    this.allowReconnect = false;
    this.clearReconnectTimer();
    const shouldLogout = options?.logout === true;

    const socket = this.socket;
    this.socket = null;
    this.saveCreds = null;
    this.liveSinceUnixSec = null;
    this.seenMessageKeys.clear();

    if (shouldLogout && socket?.logout) {
      try {
        await socket.logout();
      } catch {
        // Ignored. We still force-close and mark disconnected.
      }
    }

    if (socket?.end) {
      socket.end();
    }

    this.updateStatus({
      state: "disconnected",
      connected: false,
      qr: null,
      qrUpdatedAt: null,
      qrGenerationCount: 0,
      qrLocked: false,
      inboundSyncState: "bootstrapping",
      inboundLiveAt: null
    });
    return this.status();
  }

  async stop(): Promise<void> {
    await this.disconnect({ logout: false });
  }

  onMessage(handler: (message: BaileysInboundMessage) => Promise<void> | void): void {
    this.inboundHandler = handler;
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!isAllowedRemoteJid(jid)) {
      throw new Error("baileys_invalid_jid");
    }
    const normalizedText = text.replace(/\0/g, "").trim().slice(0, this.maxTextChars);
    if (!normalizedText) {
      throw new Error("baileys_empty_text");
    }
    if (!this.socket) {
      throw new Error("baileys_not_connected");
    }

    await this.socket.sendMessage(jid, { text: normalizedText });
  }

  async sendFile(
    jid: string,
    filePath: string,
    options?: { fileName?: string; mimeType?: string; caption?: string }
  ): Promise<void> {
    if (!isAllowedRemoteJid(jid)) {
      throw new Error("baileys_invalid_jid");
    }
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
      throw new Error("baileys_invalid_file_path");
    }
    if (!this.socket) {
      throw new Error("baileys_not_connected");
    }

    const buffer = await fs.readFile(trimmedPath);
    const fileName = (options?.fileName ?? trimmedPath.split(/[\\/]/).pop() ?? "attachment").trim() || "attachment";
    const mimeType = options?.mimeType?.trim() || "application/octet-stream";
    const caption = options?.caption?.trim();

    await this.socket.sendMessage(jid, {
      document: buffer,
      fileName,
      mimetype: mimeType,
      caption
    });
  }

  private async connectInternal(): Promise<void> {
    this.liveSinceUnixSec = null;
    this.seenMessageKeys.clear();
    this.updateStatus({
      state: "connecting",
      connected: false,
      lastError: null,
      qr: null,
      qrUpdatedAt: null,
      qrGenerationCount: 0,
      qrLocked: false,
      inboundSyncState: "bootstrapping",
      inboundLiveAt: null
    });

    try {
      await this.repairPartialCreds();
      const module = await this.loadModule();
      const authState = await module.useMultiFileAuthState(this.authDir);
      const version = await module.fetchLatestBaileysVersion();
      this.saveCreds = authState.saveCreds;

      const socket = module.default({
        auth: authState.state,
        browser: ["Alfred", "Chrome", "1.0.0"],
        version: version.version
      });
      this.socket = socket;
      this.bindSocket(socket);
    } catch (error) {
      this.updateStatus({
        state: "error",
        connected: false,
        lastError: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async repairPartialCreds(): Promise<void> {
    const credsPath = path.join(this.authDir, "creds.json");
    let parsed: unknown;
    try {
      const raw = await fs.readFile(credsPath, "utf8");
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    const registered = parsed.registered === true;
    const hasMe = isRecord(parsed.me);
    const hasAccount = isRecord(parsed.account);
    if (registered || (!hasMe && !hasAccount)) {
      return;
    }

    const backupPath = path.join(this.authDir, `creds.partial.${Date.now()}.json`);
    try {
      await fs.rename(credsPath, backupPath);
      this.updateStatus({
        lastError: "baileys_partial_creds_reset"
      });
    } catch {
      // If backup fails, continue with existing creds and let connect surface the error.
    }
  }

  private bindSocket(socket: BaileysSocket): void {
    socket.ev.on("creds.update", () => {
      if (!this.saveCreds) {
        return;
      }
      void this.saveCreds().catch(() => {
        this.updateStatus({
          lastError: "baileys_save_creds_failed"
        });
      });
    });

    socket.ev.on("connection.update", (payload) => {
      this.handleConnectionUpdate(payload);
    });

    socket.ev.on("messages.upsert", (payload) => {
      void this.handleMessagesUpsert(payload);
    });
  }

  private handleConnectionUpdate(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const update = payload as Record<string, unknown>;
    const connection = typeof update.connection === "string" ? update.connection : null;
    const qr = typeof update.qr === "string" ? update.qr : null;
    const code = safeDisconnectCode(update);
    const reason = safeDisconnectReason(update);
    const restartRequired = code === 515 || (typeof reason === "string" && reason.toLowerCase().includes("restart required"));

    if (qr) {
      const nextQrGenerationCount = this.statusValue.qrGenerationCount + 1;
      if (nextQrGenerationCount > this.maxQrGenerations) {
        this.allowReconnect = false;
        const socket = this.socket;
        this.socket = null;
        if (socket?.end) {
          socket.end();
        }
        this.updateStatus({
          state: "disconnected",
          connected: false,
          qr: null,
          qrUpdatedAt: null,
          qrGenerationCount: this.maxQrGenerations,
          qrLocked: true,
          lastError: "baileys_qr_generation_limit_reached"
        });
        return;
      }

      this.updateStatus({
        qr,
        qrUpdatedAt: nowIso(),
        state: "connecting",
        connected: false,
        qrGenerationCount: nextQrGenerationCount,
        qrLocked: false
      });
    }

    if (connection === "open") {
      this.liveSinceUnixSec = Math.floor(Date.now() / 1000) - this.historyGraceWindowSec;
      this.updateStatus({
        state: "connected",
        connected: true,
        qr: null,
        qrUpdatedAt: null,
        qrGenerationCount: 0,
        qrLocked: false,
        meId: this.socket?.user?.id ?? null,
        lastError: null,
        inboundSyncState: "live",
        inboundLiveAt: nowIso()
      });
      return;
    }

    if (restartRequired) {
      this.updateStatus({
        state: this.allowReconnect ? "connecting" : "disconnected",
        connected: false,
        qr: null,
        qrUpdatedAt: null,
        qrLocked: false,
        meId: null,
        lastDisconnectCode: code,
        lastDisconnectReason: reason,
        inboundSyncState: "bootstrapping",
        inboundLiveAt: null
      });
      this.liveSinceUnixSec = null;
      this.seenMessageKeys.clear();

      const socket = this.socket;
      this.socket = null;
      if (socket?.end) {
        socket.end();
      }

      if (!this.allowReconnect) {
        this.updateStatus({ state: "disconnected" });
        return;
      }

      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        void this.connect().catch((error) => {
          this.updateStatus({
            state: "error",
            connected: false,
            lastError: error instanceof Error ? error.message : String(error)
          });
        });
      }, Math.min(this.reconnectDelayMs, 1000));
      return;
    }

    if (connection !== "close") {
      return;
    }

    this.updateStatus({
      state: this.allowReconnect ? "connecting" : "disconnected",
      connected: false,
      qr: null,
      qrUpdatedAt: null,
      qrLocked: false,
      meId: null,
      lastDisconnectCode: code,
      lastDisconnectReason: reason,
      inboundSyncState: "bootstrapping",
      inboundLiveAt: null
    });

    this.liveSinceUnixSec = null;
    this.seenMessageKeys.clear();
    this.socket = null;
    if (!this.allowReconnect || code === 401) {
      this.updateStatus({ state: "disconnected" });
      return;
    }

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => {
        this.updateStatus({
          state: "error",
          connected: false,
          lastError: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.reconnectDelayMs);
  }

  private async handleMessagesUpsert(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const upsert = payload as Record<string, unknown>;
    const messages =
      "messages" in upsert && Array.isArray(upsert.messages)
        ? (upsert.messages as Array<Record<string, unknown>>)
        : [];
    if (messages.length === 0) {
      return;
    }

    const upsertType = typeof upsert.type === "string" ? upsert.type.toLowerCase() : "";
    if (upsertType && upsertType !== "notify") {
      this.updateStatus({
        ignoredNonNotifyCount: this.statusValue.ignoredNonNotifyCount + messages.length
      });
      return;
    }

    if (!this.statusValue.connected || this.liveSinceUnixSec === null) {
      this.updateStatus({
        ignoredPreLiveCount: this.statusValue.ignoredPreLiveCount + messages.length
      });
      return;
    }

    let acceptedCount = 0;
    let ignoredStaleCount = 0;
    let ignoredDuplicateCount = 0;
    let ignoredUnsupportedJidCount = 0;
    let ignoredFromMeCount = 0;
    let ignoredSenderNotAllowedCount = 0;
    let ignoredMissingPrefixCount = 0;

    for (const message of messages) {
      const key =
        "key" in message && message.key && typeof message.key === "object"
          ? (message.key as Record<string, unknown>)
          : null;
      const fromMe = key?.fromMe === true;
      const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : "";
      const id = typeof key?.id === "string" ? key.id : "";
      if (!remoteJid || !id || !isAllowedRemoteJid(remoteJid)) {
        ignoredUnsupportedJidCount += 1;
        continue;
      }

      const messageKey = remoteJid + ":" + id;
      if (this.seenMessageKeys.has(messageKey)) {
        ignoredDuplicateCount += 1;
        continue;
      }
      this.trackSeenMessageKey(messageKey);

      const messageTimestampSeconds = safeMessageTimestampSeconds(message.messageTimestamp);
      if (messageTimestampSeconds !== null && messageTimestampSeconds < this.liveSinceUnixSec) {
        ignoredStaleCount += 1;
        continue;
      }

      if (fromMe && !this.allowSelfFromMe) {
        ignoredFromMeCount += 1;
        continue;
      }
      const senderKey = canonicalSenderKey(remoteJid);
      if (!fromMe && this.allowedSenders.size > 0 && !this.allowedSenders.has(senderKey)) {
        ignoredSenderNotAllowedCount += 1;
        continue;
      }

      const text = extractMessageText(
        "message" in message && message.message && typeof message.message === "object"
          ? (message.message as Record<string, unknown>)
          : null
      );
      const normalizedText = text.replace(/\0/g, "").trim().slice(0, this.maxTextChars);
      if (!normalizedText) {
        continue;
      }

      const inboundText = this.applyRequiredPrefix(normalizedText);
      if (!inboundText) {
        ignoredMissingPrefixCount += 1;
        continue;
      }

      const payloadMessage: BaileysInboundMessage = {
        key: {
          id,
          remoteJid
        },
        message: {
          conversation: inboundText
        },
        pushName: typeof message.pushName === "string" ? message.pushName : undefined,
        messageTimestamp: messageTimestampSeconds ?? undefined
      };

      try {
        await this.onInbound(payloadMessage);
        if (this.inboundHandler) {
          await this.inboundHandler(payloadMessage);
        }
        acceptedCount += 1;
      } catch (error) {
        this.updateStatus({
          lastError: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (
      acceptedCount > 0 ||
      ignoredStaleCount > 0 ||
      ignoredDuplicateCount > 0 ||
      ignoredUnsupportedJidCount > 0 ||
      ignoredFromMeCount > 0 ||
      ignoredSenderNotAllowedCount > 0 ||
      ignoredMissingPrefixCount > 0
    ) {
      this.updateStatus({
        acceptedMessageCount: this.statusValue.acceptedMessageCount + acceptedCount,
        ignoredStaleCount: this.statusValue.ignoredStaleCount + ignoredStaleCount,
        ignoredDuplicateCount: this.statusValue.ignoredDuplicateCount + ignoredDuplicateCount,
        ignoredUnsupportedJidCount: this.statusValue.ignoredUnsupportedJidCount + ignoredUnsupportedJidCount,
        ignoredFromMeCount: this.statusValue.ignoredFromMeCount + ignoredFromMeCount,
        ignoredSenderNotAllowedCount: this.statusValue.ignoredSenderNotAllowedCount + ignoredSenderNotAllowedCount,
        ignoredMissingPrefixCount: this.statusValue.ignoredMissingPrefixCount + ignoredMissingPrefixCount
      });
    }
  }

  private updateStatus(partial: Partial<BaileysRuntimeStatus>): void {
    this.statusValue = {
      ...this.statusValue,
      ...partial,
      updatedAt: nowIso()
    };
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private trackSeenMessageKey(messageKey: string): void {
    this.seenMessageKeys.add(messageKey);
    if (this.seenMessageKeys.size <= MAX_SEEN_MESSAGE_KEYS) {
      return;
    }
    const oldest = this.seenMessageKeys.values().next();
    if (!oldest.done) {
      this.seenMessageKeys.delete(oldest.value);
    }
  }

  private applyRequiredPrefix(text: string): string {
    if (!this.requirePrefix) {
      return text;
    }

    const prefix = this.requirePrefix.trim();
    if (!prefix) {
      return text;
    }

    const lowerText = text.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (!lowerText.startsWith(lowerPrefix)) {
      return "";
    }

    let stripped = text.slice(prefix.length).trimStart();
    if (stripped.startsWith(":") || stripped.startsWith("-")) {
      stripped = stripped.slice(1).trimStart();
    }

    return stripped;
  }
}
