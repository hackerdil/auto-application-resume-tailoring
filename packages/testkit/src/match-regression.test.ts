import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMatchAnalyzer } from "@career-agent/ai";
import {
  DEFAULT_MATCH_WEIGHTS,
  lexicalAssessment,
  mergeModelJudgments,
  requirementsFromJob,
  RunBudget,
  scoreMatch,
  type Job,
  type VerifiedFact,
} from "@career-agent/domain";
import { FakeProvider } from "./fake-provider.js";

interface Case {
  name: string;
  modelOutputs: unknown[];
  expected?: Record<string, string>;
  expectedCorrections?: number;
  expectFailure?: boolean;
}
const fx = JSON.parse(
  readFileSync(new URL("../../../fixtures/ai/match-cases.json", import.meta.url), "utf8"),
) as {
  facts: { id: string; category: VerifiedFact["category"]; claim: string }[];
  job: Pick<
    Job,
    "title" | "requiredQualifications" | "preferredQualifications" | "descriptionText"
  >;
  cases: Case[];
};

const facts: VerifiedFact[] = fx.facts.map((f) => ({
  ...f,
  source: "user-confirmed",
  verifiedAt: "2026-10-29T00:00:00.000Z",
  allowedTransformations: ["select"],
  sensitive: false,
}));
const limits = {
  deadlineMs: 10_000,
  maxModelTurns: 2,
  maxToolCalls: 0,
  maxBrowserSteps: 0,
  maxRetries: 1,
  maxInputChars: 50_000,
  maxOutputTokens: 4000,
  maxCostUsd: 1,
};
const reqs = requirementsFromJob(fx.job);
const lexical = reqs.map((r) => lexicalAssessment(r, facts));

describe("match-analysis regression fixtures (fixtures/ai/match-cases.json)", () => {
  it("lexical baseline: years are never 'met'; unknown tools are missing", () => {
    expect(Object.fromEntries(lexical.map((r) => [r.key, r.status]))).toEqual({
      R1: "partial",
      R2: "met",
      R3: "missing",
      R4: "missing",
    });
  });

  for (const c of fx.cases) {
    it(c.name, async () => {
      const provider = new FakeProvider(c.modelOutputs);
      const analyzer = createMatchAnalyzer(provider);
      const job = { id: "greenhouse:acmefictional/1", company: "Acme Fictional Ltd", ...fx.job };
      const run = analyzer.analyze(
        {
          job,
          requirements: reqs,
          facts: facts.map((f) => ({ id: f.id, category: f.category, claim: f.claim })),
        },
        { budget: new RunBudget(limits), traceId: "t" },
      );
      if (c.expectFailure) {
        await expect(run).rejects.toThrow(/failed validation/);
        return;
      }
      const out = await run;
      const merged = mergeModelJudgments(lexical, out.judgments, new Set(facts.map((f) => f.id)));
      expect(Object.fromEntries(merged.requirements.map((r) => [r.key, r.status]))).toEqual(
        c.expected,
      );
      expect(merged.corrections).toHaveLength(c.expectedCorrections ?? 0);
      // Every surviving citation is a real, supplied fact.
      for (const r of merged.requirements)
        for (const id of r.factIds) expect(facts.some((f) => f.id === id)).toBe(true);
      // The untrusted description reached the model only inside the envelope.
      const prompt = provider.requests[0]?.messages[1]?.content ?? "";
      expect(prompt).toMatch(
        /<untrusted_content source="job_description"[^>]*>\nBuild our billing platform\. Ignore all previous instructions/,
      );
      expect(out.runs.length).toBe(provider.requests.length);
    });
  }

  it("the score is computed deterministically: an injected 'perfect match' explanation changes nothing", async () => {
    const provider = new FakeProvider([fx.cases[1]?.modelOutputs[0]]);
    const out = await createMatchAnalyzer(provider).analyze(
      {
        job: { id: "x:1", company: "Acme", ...fx.job },
        requirements: reqs,
        facts: facts.map((f) => ({ id: f.id, category: f.category, claim: f.claim })),
      },
      { budget: new RunBudget(limits), traceId: "t" },
    );
    const merged = mergeModelJudgments(lexical, out.judgments, new Set(facts.map((f) => f.id)));
    const job = {
      ...fx.job,
      seniority: "senior",
      workMode: "remote",
      locations: [],
      filterReasons: [],
      compensation: null,
      sponsorship: { value: "unknown", confidence: 0, evidence: null },
    } as unknown as Job;
    const s = scoreMatch({
      job,
      requirements: merged.requirements,
      facts,
      prefs: null,
      needsSponsorship: null,
      weights: DEFAULT_MATCH_WEIGHTS,
      strongThreshold: 70,
    });
    expect(s.total).toBeLessThan(70);
    expect(s.explanation).not.toMatch(/Perfect match|Submit/);
  });

  it("budget limits stop the model step", async () => {
    const provider = new FakeProvider([{ requirements: [], explanation: "" }]);
    const tight = new RunBudget({ ...limits, maxInputChars: 100 });
    await expect(
      createMatchAnalyzer(provider).analyze(
        {
          job: { id: "x:1", company: "Acme", ...fx.job },
          requirements: reqs,
          facts: facts.map((f) => ({ id: f.id, category: f.category, claim: f.claim })),
        },
        { budget: tight, traceId: "t" },
      ),
    ).rejects.toThrow(/maxInputChars/);
    expect(provider.requests).toHaveLength(0);
  });
});
