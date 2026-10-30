import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactStorageName, resolveInside } from "./path-safety.js";
import { escapeCsvCell, toCsv } from "./csv.js";

describe("resolveInside", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ca-path-"));

  it("resolves normal relative paths", () => {
    expect(resolveInside(root, "ab/file.pdf")).toBe(path.join(path.resolve(root), "ab/file.pdf"));
  });

  it.each(["../x", "a/../../x", "/etc/passwd", "a\0b", ".", ""])("rejects %j", (p) => {
    expect(() => resolveInside(root, p)).toThrow();
  });

  it("rejects symlinks that escape the root", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "ca-outside-"));
    mkdirSync(path.join(root, "links"), { recursive: true });
    symlinkSync(outside, path.join(root, "links", "out"));
    expect(() => resolveInside(root, "links/out/secret.txt")).toThrow(/escapes/);
  });
});

describe("artifactStorageName", () => {
  const h = "a".repeat(64);
  it("builds content-addressed names", () => {
    expect(artifactStorageName(h, ".PDF")).toBe(`aa/${h}.pdf`);
  });
  it("rejects bad hashes and extensions", () => {
    expect(() => artifactStorageName("../x", "pdf")).toThrow();
    expect(() => artifactStorageName(h, "exe")).toThrow();
  });
});

describe("CSV export", () => {
  it.each([
    ['=HYPERLINK("x")', '"\'=HYPERLINK(""x"")"'],
    ["+1", "'+1"],
    ["-2", "'-2"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    [null, ""],
  ])("escapes %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });
  it("joins rows", () => {
    expect(
      toCsv([
        ["a", 1],
        ["b", "=x"],
      ]),
    ).toBe("a,1\r\nb,'=x");
  });
});
