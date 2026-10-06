import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";

/** Encrypts small secrets (TOTP seeds) at rest with AES-256-GCM and keys recovery-code hashes. */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.DATA_ENCRYPTION_KEY, "base64");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, ciphertext]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext)
      throw new Error("Unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  /** Keyed hash for one-time codes: useless without the server key even if the database leaks. */
  hmac(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
}
