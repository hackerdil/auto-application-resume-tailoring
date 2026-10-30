import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString } from "./redaction.js";

describe("redaction", () => {
  it.each([
    "sk-proj-" + "a".repeat(30),
    "sk-ant-api03-" + "b".repeat(30),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "ghp_" + "c".repeat(36),
    "Bearer abcdefghijklmnop.qrstuv",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlc2ln",
    "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
  ])("redacts secret-looking value %#", (secret) => {
    const out = redactString(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^before .* after$/);
  });

  it("redacts sensitive query parameters but keeps the rest of the URL", () => {
    expect(redactString("https://x.test/cb?code=abc123&state=ok&token=zzz")).toBe(
      `https://x.test/cb?code=${REDACTED}&state=ok&token=${REDACTED}`,
    );
  });

  it("redacts sensitive keys at any depth and configured exact values", () => {
    const input = {
      headers: { Authorization: "x", cookie: "y", "x-trace": "keep" },
      user: { password: "hunter2", otp: "123456", name: "Alex", note: "SSN is 900-00-1234" },
      list: [{ apiKey: "k" }],
    };
    const out = redact(input, { extraValues: ["900-00-1234"] }) as typeof input;
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.cookie).toBe(REDACTED);
    expect(out.headers["x-trace"]).toBe("keep");
    expect(out.user.password).toBe(REDACTED);
    expect(out.user.otp).toBe(REDACTED);
    expect(out.user.name).toBe("Alex");
    expect(out.user.note).toBe(`SSN is ${REDACTED}`);
    expect(out.list[0]?.apiKey).toBe(REDACTED);
    expect(input.user.password).toBe("hunter2"); // not mutated
  });

  it("handles cycles, depth, and errors", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc["self"] = cyc;
    expect(redact(cyc)).toEqual({ a: 1, self: "[Circular]" });
    expect(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: "[Truncated]" } });
    expect(redact(new Error("token sk-proj-" + "a".repeat(30)))).toEqual({
      name: "Error",
      message: `token ${REDACTED}`,
    });
  });
});
