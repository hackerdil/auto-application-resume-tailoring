import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Used for hashes and MACs, so it
 * rejects values JSON would silently drop or alter (undefined, functions, NaN/Infinity, bigint).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value)) throw new TypeError("canonicalJson: circular structure");
      seen.add(value);
      try {
        if (Array.isArray(value)) return `[${value.map((v) => serialize(v, seen)).join(",")}]`;
        if (value instanceof Date) return JSON.stringify(value.toISOString());
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen)}`).join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256Hex(key: Uint8Array, data: string | Uint8Array): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** HKDF-SHA256 key derivation with a purpose label, e.g. deriveKey(secret, "approval-v1"). */
export function deriveKey(secret: Uint8Array, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, length));
}

/** Constant-time comparison of two hex strings. Different lengths compare false without leaking content. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function randomTokenBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
