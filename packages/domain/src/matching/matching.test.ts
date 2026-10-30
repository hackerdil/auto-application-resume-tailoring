import { describe, expect, it } from "vitest";
import { lexicalAssessment, matchableFacts, requirementsFromJob } from "./evidence.js";
import { mergeModelJudgments } from "./model-judgments.js";
import { scoreMatch, type ScoreInput } from "./score.js";
import { tokens } from "./text.js";
import { DEFAULT_MATCH_WEIGHTS } from "../schemas/match.js";
import { Preferences } from "../schemas/profile.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { Job } from "../schemas/job.js";

let n = 0;
const fact = (claim: string, over: Partial<VerifiedFact> = {}): VerifiedFact => ({
  id: `0190f0b0-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  category: "skill",
  claim,
  source: "user-confirmed",
  verifiedAt: "2026-10-29T00:00:00.000Z",
  allowedTransformations: ["select"],
  sensitive: false,
  ...over,
});

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "lever:x/1",
    title: "Senior Backend Engineer",
    company: "Acme",
    seniority: "senior",
    workMode: "remote",
    locations: ["Remote"],
    descriptionText:
      "We build billing services in TypeScript and PostgreSQL. TypeScript services, billing APIs, PostgreSQL tuning, observability, on-call.",
    requiredQualifications: ["TypeScript", "PostgreSQL experience"],
    preferredQualifications: ["Kafka"],
    compensation: { min: 90000, max: 110000, currency: "EUR", period: "year" },
    sponsorship: { value: "unknown", confidence: 0, evidence: null },
    filterReasons: [],
    contentHash: "c".repeat(64),
    ...over,
  }) as Job;

const facts = [
  fact("TypeScript"),
  fact("PostgreSQL"),
  fact("Built billing services in TypeScript", { category: "achievement" }),
  fact("Senior Software Engineer, Acme Fictional Ltd", { category: "role" }),
];

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  const j = over.job ?? job();
  return {
    job: j,
    requirements: requirementsFromJob(j).map((r) => lexicalAssessment(r, facts)),
    facts,
    prefs: Preferences.parse({
      targetRoles: ["Backend Engineer"],
      workModes: ["remote"],
      compensation: { min: 80000, max: null, currency: "EUR", period: "year" },
    }),
    needsSponsorship: false,
    weights: DEFAULT_MATCH_WEIGHTS,
    strongThreshold: 70,
    ...over,
  };
}

describe("tokens", () => {
  it("normalizes aliases, phrases, plurals and removes filler words", () => {
    expect(tokens("5+ years of strong experience with JS, k8s and Postgres")).toEqual([
      "javascript",
      "kubernetes",
      "postgresql",
    ]);
    expect(tokens("C++, C#, .NET, Node.js, CI/CD, machine learning pipelines")).toEqual([
      "cplusplus",
      "csharp",
      "dotnet",
      "nodejs",
      "cicd",
      "machine-learning",
      "pipeline",
    ]);
  });
});

describe("lexical evidence", () => {
  it("cites facts for met requirements and stays conservative", () => {
    const [ts, pg, kafka] = requirementsFromJob(job()).map((r) => lexicalAssessment(r, facts));
    expect(ts).toMatchObject({ key: "R1", status: "met", source: "lexical" });
    expect(ts?.factIds.length).toBeGreaterThan(0);
    expect(pg?.status).toBe("met");
    expect(kafka).toMatchObject({ key: "R3", kind: "preferred", status: "missing", factIds: [] });
  });

  it("treats short 'or' alternatives as satisfied by any one of them", () => {
    expect(
      lexicalAssessment({ key: "R1", text: "Go or Rust", kind: "required" }, [fact("Go")]).status,
    ).toBe("met");
    expect(
      lexicalAssessment({ key: "R1", text: "AWS/GCP", kind: "required" }, [fact("AWS")]).status,
    ).toBe("met");
    // Long prose is not split: both halves stay required.
    const prose =
      "Experience designing distributed payment systems or leading platform migrations across teams";
    expect(
      lexicalAssessment({ key: "R1", text: prose, kind: "required" }, [
        fact("Led platform migrations"),
      ]).status,
    ).not.toBe("met");
  });

  it("never marks stated years of experience as met", () => {
    const r = lexicalAssessment(
      { key: "R1", text: "5+ years of TypeScript", kind: "required" },
      facts,
    );
    expect(r.status).toBe("partial");
    expect(r.rationale).toMatch(/cannot be verified/);
  });

  it("excludes sensitive and superseded facts from matching", () => {
    const pool = matchableFacts([
      fact("TypeScript", { sensitive: true }),
      fact("Go", { supersededBy: "0190f0b0-0000-7000-8000-000000000999" }),
      fact("Rust"),
    ]);
    expect(pool.map((f) => f.claim)).toEqual(["Rust"]);
  });
});

describe("model judgments", () => {
  it("cannot invent evidence or requirements", () => {
    const lexical = requirementsFromJob(job()).map((r) => lexicalAssessment(r, facts));
    const allowed = new Set(facts.map((f) => f.id));
    const { requirements, corrections } = mergeModelJudgments(
      lexical,
      [
        { key: "R3", status: "met", factIds: ["made-up"], rationale: "Kafka" },
        { key: "R9", status: "met", factIds: [], rationale: "?" },
        { key: "R2", status: "missing", factIds: [], rationale: "Model disagrees" },
      ],
      allowed,
    );
    expect(requirements.map((r) => [r.key, r.status, r.source])).toEqual([
      ["R1", "met", "lexical"],
      ["R2", "missing", "model"],
      ["R3", "unknown", "model"],
    ]);
    expect(corrections).toHaveLength(3);
  });
});

describe("scoreMatch", () => {
  it("scores a good fit as strong with per-dimension rationales", () => {
    const s = scoreMatch(input());
    expect(s.verdict).toBe("strong");
    expect(s.total).toBeGreaterThanOrEqual(70);
    expect(s.dimensions.roleAlignment.score).toBe(100);
    expect(s.dimensions.seniorityAlignment.score).toBe(100);
    for (const d of Object.values(s.dimensions)) expect(d.rationale.length).toBeGreaterThan(0);
    expect(s.explanation).toMatch(/not an employer ATS score/);
  });

  it("never calls a match strong without requirement evidence", () => {
    const noReqs = job({ requiredQualifications: [], preferredQualifications: [] });
    const s = scoreMatch(input({ job: noReqs, requirements: [], strongThreshold: 40 }));
    expect(s.dimensions.mustHaveSkills.unknown).toBe(true);
    expect(s.total).toBeGreaterThanOrEqual(40);
    expect(s.verdict).toBe("possible");
  });

  it("uses neutral, flagged scores for unknown information", () => {
    const s = scoreMatch(
      input({
        prefs: null,
        needsSponsorship: null,
        job: job({ compensation: null, seniority: "unknown" }),
      }),
    );
    for (const k of [
      "roleAlignment",
      "seniorityAlignment",
      "locationFit",
      "authorizationFit",
      "compensationFit",
      "preferenceFit",
    ] as const) {
      expect(s.dimensions[k]).toMatchObject({ score: 50, unknown: true });
    }
    expect(s.unknowns.join()).toMatch(/target roles/);
  });

  it("disqualifies only on explicit sponsorship need versus an explicit 'not offered'", () => {
    const notOffered = job({
      sponsorship: { value: "not_offered", confidence: 0.8, evidence: "We cannot sponsor visas." },
    });
    expect(scoreMatch(input({ job: notOffered, needsSponsorship: true })).verdict).toBe(
      "disqualified",
    );
    expect(scoreMatch(input({ job: notOffered, needsSponsorship: false })).verdict).toBe("strong");
    const unknown = scoreMatch(input({ job: notOffered, needsSponsorship: null }));
    expect(unknown.verdict).not.toBe("disqualified");
    expect(unknown.unknowns.join()).toMatch(/visa sponsorship/);
  });

  it("carries hard filter reasons into a disqualified verdict", () => {
    const s = scoreMatch(input({ job: job({ filterReasons: ["excluded_company: Acme"] }) }));
    expect(s.verdict).toBe("disqualified");
    expect(s.dimensions.preferenceFit.score).toBe(0);
  });

  it("is unaffected by sensitive facts (protected characteristics never feed scoring)", () => {
    const sensitive = [
      fact("Born 1980", { category: "identity", sensitive: true }),
      fact("Nationality: Exampleland", { category: "identity", sensitive: true }),
    ];
    const base = scoreMatch(input());
    const withSensitive = scoreMatch(input({ facts: matchableFacts([...facts, ...sensitive]) }));
    expect(withSensitive.total).toBe(base.total);
  });

  it("weights sum to 1 so totals stay within 0–100", () => {
    expect(Object.values(DEFAULT_MATCH_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const worst = scoreMatch(
      input({
        facts: [],
        requirements: requirementsFromJob(job()).map((r) => lexicalAssessment(r, [])),
      }),
    );
    expect(worst.total).toBeGreaterThanOrEqual(0);
  });
});
