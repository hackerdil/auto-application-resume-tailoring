import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@career-agent/domain";
import { FieldCipher, parseDataKey } from "./encryption.js";

const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe("FieldCipher", () => {
  const cipher = new FieldCipher("k1", { k1 });

  it("round-trips and produces fresh ciphertext each time", () => {
    const a = cipher.encrypt("salary: 100k", "saved_answers.value:row1");
    const b = cipher.encrypt("salary: 100k", "saved_answers.value:row1");
    expect(a).not.toBe(b);
    expect(a).not.toContain("salary");
    expect(cipher.decrypt(a, "saved_answers.value:row1")).toBe("salary: 100k");
  });

  it("fails with the wrong key", () => {
    const other = new FieldCipher("k1", { k1: k2 });
    expect(() => other.decrypt(cipher.encrypt("x", "c"), "c")).toThrow(ValidationError);
  });

  it("fails when moved to another row or column (AAD binding)", () => {
    const ct = cipher.encrypt("x", "saved_answers.value:row1");
    expect(() => cipher.decrypt(ct, "saved_answers.value:row2")).toThrow(/decryption failed/);
  });

  it("detects tampering", () => {
    const ct = cipher.encrypt("hello world", "c").split(":");
    const body = Buffer.from(ct[4] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    ct[4] = body.toString("base64url");
    expect(() => cipher.decrypt(ct.join(":"), "c")).toThrow(/decryption failed/);
  });

  it("supports key rotation", () => {
    const old = cipher.encrypt("x", "c");
    const rotated = new FieldCipher("k2", { k1, k2 });
    expect(rotated.decrypt(old, "c")).toBe("x");
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt("x", "c"))).toBe(false);
  });

  it("rejects malformed payloads and bad keys", () => {
    expect(() => cipher.decrypt("plain text", "c")).toThrow(/format/);
    expect(() => new FieldCipher("k1", { k1: randomBytes(16) })).toThrow();
    expect(() => parseDataKey(randomBytes(16).toString("base64"))).toThrow(/32 random bytes/);
    expect(parseDataKey(k1.toString("base64")).equals(k1)).toBe(true);
    expect(parseDataKey(k1.toString("base64url")).equals(k1)).toBe(true);
  });
});
