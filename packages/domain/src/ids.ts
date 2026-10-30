import { getRandomValues } from "node:crypto";

let lastMs = -1;
let lastRand: Uint8Array = new Uint8Array(10);

/**
 * RFC 9562 UUIDv7: 48-bit Unix ms timestamp, version 7, variant 10, 74 random bits.
 * Within one millisecond the random part is incremented so IDs stay monotonic (ADR-015).
 */
export function uuidv7(now: number = Date.now()): string {
  let rand: Uint8Array;
  if (now <= lastMs) {
    rand = increment(lastRand);
    now = lastMs;
  } else {
    rand = getRandomValues(new Uint8Array(10));
  }
  lastMs = now;
  lastRand = rand;

  const b = new Uint8Array(16);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  b.set(rand, 6);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function increment(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    const v = (out[i] ?? 0) + 1;
    out[i] = v & 0xff;
    if (v <= 0xff) return out;
  }
  // Overflow inside one millisecond is astronomically unlikely; fall back to fresh randomness.
  return getRandomValues(new Uint8Array(10));
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/** Canonical job ID: `source:externalId`. Neither part may be empty; the source may not contain ':'. */
export function canonicalJobId(source: string, externalId: string): string {
  const s = source.trim().toLowerCase();
  const e = externalId.trim();
  if (!s || !e || s.includes(":")) {
    throw new TypeError(
      "canonicalJobId requires a non-empty source without ':' and a non-empty externalId",
    );
  }
  return `${s}:${e}`;
}
