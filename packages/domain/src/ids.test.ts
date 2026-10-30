import { describe, expect, it } from "vitest";
import { canonicalJobId, isUuidV7, uuidv7 } from "./ids.js";

describe("uuidv7", () => {
  it("produces RFC 9562 v7 ids", () => {
    for (let i = 0; i < 100; i++) expect(isUuidV7(uuidv7())).toBe(true);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    // Must be later than any id generated so far; earlier timestamps are clamped for monotonicity.
    const ts = Date.now() + 1_000_000;
    const id = uuidv7(ts);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(ts);
  });

  it("is strictly increasing within the same millisecond and across a clock step back", () => {
    const ts = Date.now() + 10_000;
    const ids = [uuidv7(ts), uuidv7(ts), uuidv7(ts), uuidv7(ts - 5)];
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("canonicalJobId", () => {
  it("joins source and external id", () => {
    expect(canonicalJobId("Greenhouse", " 12345 ")).toBe("greenhouse:12345");
  });
  it.each([
    ["", "1"],
    ["lever", ""],
    ["a:b", "1"],
  ])("rejects (%s, %s)", (s, e) => {
    expect(() => canonicalJobId(s, e)).toThrow(TypeError);
  });
});
