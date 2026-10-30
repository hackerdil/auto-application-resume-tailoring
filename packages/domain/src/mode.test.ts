import { describe, expect, it } from "vitest";
import { PolicyError } from "./errors.js";
import { assertModeAllows, DEFAULT_MODE, modeAllows } from "./mode.js";

describe("operating modes", () => {
  it("defaults to review-each", () => {
    expect(DEFAULT_MODE).toBe("review-each");
  });

  it("only review-each can issue approvals or submit", () => {
    for (const mode of ["research-only", "prepare", "dry-run"] as const) {
      expect(modeAllows(mode, "issue_approval")).toBe(false);
      expect(modeAllows(mode, "submit")).toBe(false);
      expect(modeAllows(mode, "external_write")).toBe(false);
    }
    expect(modeAllows("review-each", "submit")).toBe(true);
  });

  it("research-only does no tailoring, auth, or preparation", () => {
    for (const c of ["tailor", "draft", "authenticate", "open_browser", "prefill"] as const) {
      expect(modeAllows("research-only", c)).toBe(false);
    }
  });

  it("dry-run never authenticates", () => {
    expect(() => {
      assertModeAllows("dry-run", "authenticate");
    }).toThrow(PolicyError);
  });
});
