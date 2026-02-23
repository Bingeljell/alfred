import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncodedSecret =
  | {
      scheme: "plain";
      value: string;
    }
  | {
      scheme: "aes-256-gcm";
      value: string;
      iv: string;
      tag: string;
    };

export class OAuthSecretCodec {
  private readonly key: Buffer | null;

  constructor(secretKey?: string) {
    const trimmed = secretKey?.trim();
    this.key = trimmed ? createHash("sha256").update(trimmed).digest() : null;
  }

  storageScheme(): EncodedSecret["scheme"] {
    return this.key ? "aes-256-gcm" : "plain";
  }

  encode(value: string): EncodedSecret {
    if (!this.key) {
      return {
        scheme: "plain",
        value: Buffer.from(value, "utf8").toString("base64")
      };
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      scheme: "aes-256-gcm",
      value: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64")
    };
  }

  decode(encoded: EncodedSecret): string | null {
    if (encoded.scheme === "plain") {
      try {
        return Buffer.from(encoded.value, "base64").toString("utf8");
      } catch {
        return null;
      }
    }

    if (!this.key) {
      return null;
    }

    try {
      const iv = Buffer.from(encoded.iv, "base64");
      const tag = Buffer.from(encoded.tag, "base64");
      const encrypted = Buffer.from(encoded.value, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }
}
