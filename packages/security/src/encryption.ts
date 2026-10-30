import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ValidationError } from "@career-agent/domain";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parses a base64 (or base64url) 32-byte key; throws a ValidationError with an actionable message. */
export function parseDataKey(encoded: string, name = "DATA_ENCRYPTION_KEY"): Buffer {
  const key = Buffer.from(
    encoded.trim(),
    encoded.includes("-") || encoded.includes("_") ? "base64url" : "base64",
  );
  if (key.length !== KEY_BYTES) {
    throw new ValidationError(
      `${name} must be ${KEY_BYTES} random bytes encoded as base64 (generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").`,
    );
  }
  return key;
}

/**
 * AES-256-GCM field encryption (ADR-005).
 * Format: `v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>`.
 * `aad` binds a ciphertext to its location (e.g. "saved_answers.value:<rowId>") so values cannot be swapped
 * between rows or columns without detection.
 */
export class FieldCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    private readonly activeKeyId: string,
    keys: Record<string, Buffer>,
  ) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(activeKeyId)) throw new ValidationError("invalid key id");
    for (const [id, k] of Object.entries(keys)) {
      if (k.length !== KEY_BYTES) throw new ValidationError(`key ${id} must be ${KEY_BYTES} bytes`);
    }
    if (!keys[activeKeyId]) throw new ValidationError("active key missing from key set");
    this.keys = new Map(Object.entries(keys));
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new ValidationError("active key missing");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.activeKeyId,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ct.toString("base64url"),
    ].join(":");
  }

  decrypt(payload: string, aad: string): string {
    const parts = payload.split(":");
    if (parts.length !== 5 || parts[0] !== VERSION)
      throw new ValidationError("unrecognized ciphertext format");
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new ValidationError(`no key available for key id "${keyId}"`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (cause) {
      throw new ValidationError("decryption failed (wrong key, tampered data, or wrong context)", [
        cause instanceof Error ? cause.name : "UnknownError",
      ]);
    }
  }

  /** True when the payload was written with a key other than the active one (needs re-encryption). */
  needsRotation(payload: string): boolean {
    return payload.split(":")[1] !== this.activeKeyId;
  }
}
