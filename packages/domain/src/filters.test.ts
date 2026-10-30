import { describe, expect, it } from "vitest";
import { applyHardFilters } from "./filters.js";
import { Preferences } from "./schemas/profile.js";
import type { Job } from "./schemas/job.js";

const job = (over: Partial<Job> = {}): Job => ({
  id: "lever:x/1",
  source: "lever",
  externalId: "x/1",
  sourceUrl: "https://jobs.lever.co/x/1",
  applyUrl: null,
  company: "Acme Fictional Ltd",
  title: "Senior Backend Engineer",
  team: null,
  locations: ["Berlin, Germany"],
  workMode: "onsite",
  employmentType: "full_time",
  seniority: "senior",
  descriptionText: "",
  descriptionHtmlSanitized: null,
  requiredQualifications: [],
  preferredQualifications: [],
  compensation: { min: 60000, max: 70000, currency: "EUR", period: "year" },
  sponsorship: { value: "unknown", confidence: 0, evidence: null },
  postedAt: "2026-10-20T00:00:00.000Z",
  updatedAt: null,
  firstSeenAt: "2026-10-29T00:00:00.000Z",
  lastSeenAt: "2026-10-29T00:00:00.000Z",
  sourceHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  status: "NORMALIZED",
  filterReasons: [],
  removedFromSourceAt: null,
  ...over,
});
const prefs = (over: Partial<Preferences> = {}) => Preferences.parse(over);
const ctx = { now: new Date("2026-10-29T00:00:00Z"), freshnessDays: 30, duplicateOf: null };
const codes = (r: string[]) => r.map((x) => x.split(":")[0]);

describe("hard filters", () => {
  it("passes when nothing conflicts", () => {
    expect(applyHardFilters(job(), prefs(), ctx)).toEqual([]);
    expect(applyHardFilters(job(), null, ctx)).toEqual([]);
  });

  it("filters excluded companies regardless of case and punctuation", () => {
    expect(
      codes(applyHardFilters(job(), prefs({ excludedCompanies: ["acme fictional ltd"] }), ctx)),
    ).toEqual(["excluded_company"]);
  });

  it("filters excluded roles on whole words only", () => {
    expect(codes(applyHardFilters(job(), prefs({ excludedRoles: ["backend"] }), ctx))).toEqual([
      "excluded_role",
    ]);
    expect(
      applyHardFilters(job({ title: "Backender" }), prefs({ excludedRoles: ["backend"] }), ctx),
    ).toEqual([]);
  });

  it("filters known work modes outside preferences but never unknown ones", () => {
    expect(codes(applyHardFilters(job(), prefs({ workModes: ["remote"] }), ctx))).toEqual([
      "work_mode",
    ]);
    expect(
      applyHardFilters(job({ workMode: "unknown" }), prefs({ workModes: ["remote"] }), ctx),
    ).toEqual([]);
  });

  it("filters non-matching locations, but not remote jobs or unknown locations", () => {
    const p = prefs({ locations: ["Amsterdam"] });
    expect(codes(applyHardFilters(job(), p, ctx))).toEqual(["location"]);
    expect(applyHardFilters(job({ locations: ["Amsterdam, NL"] }), p, ctx)).toEqual([]);
    expect(applyHardFilters(job({ workMode: "remote" }), p, ctx)).toEqual([]);
    expect(applyHardFilters(job({ locations: [] }), p, ctx)).toEqual([]);
  });

  it("filters stale postings and duplicates", () => {
    expect(
      codes(applyHardFilters(job({ postedAt: "2026-08-01T00:00:00.000Z" }), null, ctx)),
    ).toEqual(["stale"]);
    expect(codes(applyHardFilters(job({ postedAt: null }), null, ctx))).toEqual([]);
    expect(codes(applyHardFilters(job(), null, { ...ctx, duplicateOf: "greenhouse:a/1" }))).toEqual(
      ["duplicate"],
    );
  });

  it("filters compensation only when comparable", () => {
    const want = { min: 80000, max: null, currency: "EUR", period: "year" as const };
    expect(codes(applyHardFilters(job(), prefs({ compensation: want }), ctx))).toEqual([
      "compensation_below_minimum",
    ]);
    expect(
      applyHardFilters(job(), prefs({ compensation: { ...want, currency: "USD" } }), ctx),
    ).toEqual([]);
    expect(
      applyHardFilters(job({ compensation: null }), prefs({ compensation: want }), ctx),
    ).toEqual([]);
  });
});
