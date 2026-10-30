import { describe, expect, it } from "vitest";
import type { VerifiedFact } from "../schemas/fact.js";
import { wordDiff } from "./diff.js";
import { groupByRole, selectFacts } from "./selection.js";
import { numbersIn, validateBullet, type BulletDraft } from "./validator.js";

let n = 0;
const fact = (claim: string, over: Partial<VerifiedFact> = {}): VerifiedFact => ({
  id: `0190f0b0-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  category: "achievement",
  claim,
  source: "resume",
  sourceArtifactId: "0190f0b0-0000-7000-8000-0000000000aa",
  verifiedAt: "2026-10-29T00:00:00.000Z",
  allowedTransformations: ["select", "reorder", "shorten", "rephrase", "combine"],
  sensitive: false,
  ...over,
});

const billing = fact("Built a TypeScript billing service used by 40 internal teams", {
  sourceLocation: "line 5",
});
const ci = fact("Reduced CI time from 30 to 12 minutes", { sourceLocation: "line 6" });
const strict = fact("Maintained Python data pipelines", {
  allowedTransformations: ["select"],
  sourceLocation: "line 8",
});
const facts = new Map([billing, ci, strict].map((f) => [f.id, f]));
const check = (b: Partial<BulletDraft> & { text: string }, allowed?: Set<string>) =>
  validateBullet(
    { sourceFactIds: [billing.id], transformation: "rephrase", ...b },
    { facts, ...(allowed ? { allowedForEntry: allowed } : {}) },
  ).map((f) => f.kind);

describe("no-drift validator", () => {
  it("accepts verbatim selection and neutral rephrasing", () => {
    expect(check({ text: billing.claim, transformation: "select" })).toEqual([]);
    expect(check({ text: "Developed a TypeScript billing service for 40 internal teams" })).toEqual(
      [],
    );
    expect(
      check({
        text: "Billing service in TypeScript, used by 40 internal teams",
        transformation: "shorten",
      }),
    ).toEqual([]);
    expect(
      check({
        text: "Built a TypeScript billing service used by 40 internal teams and reduced CI time from 30 to 12 minutes",
        sourceFactIds: [billing.id, ci.id],
        transformation: "combine",
      }),
    ).toEqual([]);
  });

  it.each([
    [
      "inflated metric",
      "Built a TypeScript billing service used by 400 internal teams",
      "unsupported_number",
    ],
    [
      "invented metric",
      "Built a TypeScript billing service used by 40 internal teams, saving $2M",
      "unsupported_number",
    ],
    [
      "added tool",
      "Built a TypeScript and Kafka billing service used by 40 internal teams",
      "unsupported_entity",
    ],
    [
      "added skill",
      "Built a scalable TypeScript billing service used by 40 internal teams",
      "unsupported_tool",
    ],
    [
      "leadership",
      "Led a TypeScript billing service used by 40 internal teams",
      "unsupported_scope",
    ],
    [
      "causal claim",
      "Built a TypeScript billing service used by 40 internal teams, which reduced costs",
      "unsupported_causal_claim",
    ],
    [
      "credential",
      "Certified engineer who built a TypeScript billing service used by 40 internal teams",
      "unsupported_entity",
    ],
  ])("rejects %s", (_name, text, kind) => {
    expect(check({ text })).toContain(kind);
  });

  it("enforces provenance, transformation permissions, and role attribution", () => {
    expect(check({ text: "x", sourceFactIds: [] })).toEqual(["missing_provenance"]);
    expect(
      check({ text: billing.claim, sourceFactIds: ["0190f0b0-0000-7000-8000-ffffffffffff"] }),
    ).toContain("missing_provenance");
    expect(
      validateBullet(
        {
          text: "Kept Python data pipelines running",
          sourceFactIds: [strict.id],
          transformation: "rephrase",
        },
        { facts },
      )
        .map((f) => f.detail)
        .join(),
    ).toMatch(/does not allow "rephrase"/);
    expect(
      check({ text: "Built a TypeScript billing service", transformation: "select" }),
    ).toContain("other");
    expect(check({ text: billing.claim, transformation: "combine" })).toContain("other");
    expect(check({ text: billing.claim, transformation: "select" }, new Set([ci.id]))).toContain(
      "chronology_mismatch",
    );
  });

  it("normalizes numbers", () => {
    expect([...numbersIn("1,200 users, 12k events, 1.5M rows, five teams, 30%")]).toEqual([
      1200, 12000, 1500000, 30, 5,
    ]);
    expect(
      check({ text: "Built a TypeScript billing service used by forty internal teams" }),
    ).toContain("unsupported_tool"); // "forty" is not normalized → flagged, never silently accepted
  });
});

describe("fact selection", () => {
  const role1 = fact("Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025", {
    category: "role",
    sourceLocation: "line 4",
  });
  const role2 = fact("Software Engineer, Globex Example Inc, 2018 - 2021", {
    category: "role",
    sourceLocation: "line 7",
  });
  const manual = fact("Gave a talk on type safety", {
    sourceArtifactId: undefined as unknown as string,
    sourceLocation: undefined as unknown as string,
    source: "user-confirmed",
  });
  const ts = fact("TypeScript", { category: "skill" });
  const cobol = fact("COBOL", { category: "skill" });
  const all = [role1, billing, ci, role2, strict, manual, ts, cobol];

  it("attributes achievements to the role they were listed under, never by guess", () => {
    const groups = groupByRole(all);
    expect(groups.map((g) => [g.role?.claim ?? null, g.achievements.map((a) => a.claim)])).toEqual([
      [role1.claim, [billing.claim, ci.claim]],
      [role2.claim, [strict.claim]],
      [null, [manual.claim]],
    ]);
  });

  it("keeps role order, ranks bullets and skills by relevance, and respects one-page caps", () => {
    const sel = selectFacts({
      facts: all,
      requirementTexts: ["CI/CD pipelines", "TypeScript"],
      citedFactIds: new Set([ci.id]),
      length: "one-page",
    });
    expect(sel.groups.map((g) => g.role?.id ?? null)).toEqual([role1.id, role2.id, null]);
    expect(sel.groups[0]?.achievements[0]?.id).toBe(ci.id);
    expect(sel.skills.map((s) => s.claim)).toEqual(["TypeScript", "COBOL"]);
    expect(sel.omitted).toEqual([]);
  });
});

describe("wordDiff", () => {
  it("marks inserted and deleted words", () => {
    expect(wordDiff("Built a billing service", "Developed a billing service")).toEqual([
      { op: "del", text: "Built" },
      { op: "ins", text: "Developed" },
      { op: "eq", text: " a billing service" },
    ]);
  });
});
