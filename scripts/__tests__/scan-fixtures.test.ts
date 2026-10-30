import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { scanRepo, scanText } from "../scan-fixtures.mjs";

const scan = scanText as (t: string) => string[];

describe("fixture PII/secret scan", () => {
  it("repository fixtures and examples are clean", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    expect((scanRepo as (r: string) => unknown[])(root)).toEqual([]);
  });

  it.each([
    ["sk-proj-" + "a".repeat(40), "OpenAI API key"],
    ["sk-ant-" + "b".repeat(40), "Anthropic API key"],
    ["AKIA" + "ABCDEFGHIJKLMNOP", "AWS access key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "Private key block"],
    ["SSN 123-45-6789", "US SSN"],
    ["card 4111 1111 1111 1111", "Payment card number"],
    ["call (415) 555-2671", "Phone number"],
  ])("flags %s", (text, rule) => {
    expect(scan(text)).toContain(rule);
  });

  it("flags real-looking email domains but allows fictional ones", () => {
    expect(scan("jane@gmail.com").join()).toMatch(/Non-fictional email/);
    expect(scan("jane.doe@example.com alex@acme.test")).toEqual([]);
  });

  it("allows fictional 555-01xx phone numbers", () => {
    expect(scan("+1 415 555 0142")).toEqual([]);
  });
});
