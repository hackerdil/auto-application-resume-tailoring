import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deriveKey,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualHex,
} from "./hashing.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and is insensitive to insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it.each([[{ a: undefined }], [{ a: NaN }], [{ a: Infinity }], [{ a: () => 1 }], [{ a: 1n }]])(
    "rejects lossy values %#",
    (v) => {
      expect(() => canonicalJson(v)).toThrow(TypeError);
    },
  );

  it("rejects cycles but allows shared references", () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(() => canonicalJson(cyc)).toThrow(/circular/);
  });
});

describe("hashes and keys", () => {
  it("sha256 matches a known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("derives distinct keys per purpose", () => {
    const secret = Buffer.alloc(32, 7);
    expect(deriveKey(secret, "approval-v1").equals(deriveKey(secret, "session-v1"))).toBe(false);
    expect(deriveKey(secret, "approval-v1")).toHaveLength(32);
  });

  it("timing-safe comparison", () => {
    const k = Buffer.alloc(32, 1);
    const mac = hmacSha256Hex(k, "data");
    expect(timingSafeEqualHex(mac, hmacSha256Hex(k, "data"))).toBe(true);
    expect(timingSafeEqualHex(mac, hmacSha256Hex(k, "datA"))).toBe(false);
    expect(timingSafeEqualHex(mac, mac.slice(0, 10))).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });
});
