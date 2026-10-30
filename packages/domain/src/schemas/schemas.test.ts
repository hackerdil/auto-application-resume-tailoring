import { describe, expect, it } from "vitest";
import { uuidv7 } from "../ids.js";
import { ApplicationAnswer, isAnswerSetComplete } from "./application.js";
import { VerifiedFact } from "./fact.js";
import { DEFAULT_MATCH_WEIGHTS, MatchWeights } from "./match.js";
import { TailoredBullet } from "./resume.js";

const answer = (over: Partial<ApplicationAnswer> = {}): ApplicationAnswer => ({
  field: {
    id: "f1",
    label: "Q",
    normalizedQuestion: "q",
    type: "text",
    required: true,
    options: [],
    category: "unknown",
    origin: "manual",
  },
  proposedValue: null,
  provenance: { kind: "none" },
  confidence: 1,
  sensitivity: "none",
  decision: "auto_fill",
  reviewerChanges: [],
  finalValue: "x",
  finalValueSetBy: "system",
  notes: [],
  ...over,
});

describe("schemas", () => {
  it("default match weights sum to 1", () => {
    expect(MatchWeights.safeParse(DEFAULT_MATCH_WEIGHTS).success).toBe(true);
    expect(MatchWeights.safeParse({ ...DEFAULT_MATCH_WEIGHTS, roleAlignment: 0.9 }).success).toBe(
      false,
    );
  });

  it("tailored bullets must cite at least one fact", () => {
    const bullet = {
      id: uuidv7(),
      text: "Built X",
      sourceFactIds: [],
      targetRequirementKeys: [],
      transformation: "rephrase",
      verifier: { deterministic: "pending", review: "pending", findings: [] },
    };
    expect(TailoredBullet.safeParse(bullet).success).toBe(false);
    expect(TailoredBullet.safeParse({ ...bullet, sourceFactIds: [uuidv7()] }).success).toBe(true);
  });

  it("verified facts need at least one allowed transformation", () => {
    const fact = {
      id: uuidv7(),
      category: "skill",
      claim: "TypeScript",
      source: "user-confirmed",
      verifiedAt: new Date().toISOString(),
      allowedTransformations: [],
      sensitive: false,
    };
    expect(VerifiedFact.safeParse(fact).success).toBe(false);
  });

  it("prohibited answers can never carry a value", () => {
    expect(ApplicationAnswer.safeParse(answer({ decision: "prohibited" })).success).toBe(false);
  });

  it("requires_user answers can only be finalized by the user", () => {
    expect(
      ApplicationAnswer.safeParse(answer({ decision: "requires_user", finalValueSetBy: "system" }))
        .success,
    ).toBe(false);
    expect(
      ApplicationAnswer.safeParse(answer({ decision: "requires_user", finalValueSetBy: "user" }))
        .success,
    ).toBe(true);
  });

  it("optional sensitive questions may stay blank; required ones may not", () => {
    const optional = answer({
      field: { ...answer().field, required: false },
      decision: "requires_user",
      finalValue: null,
      finalValueSetBy: null,
    });
    expect(isAnswerSetComplete([optional])).toBe(true);
    expect(
      isAnswerSetComplete([
        answer({ decision: "needs_review", finalValue: null, finalValueSetBy: null }),
      ]),
    ).toBe(false);
    expect(
      isAnswerSetComplete([answer({ decision: "needs_review", finalValueSetBy: "user" })]),
    ).toBe(true);
  });

  it("answer-set completeness", () => {
    expect(isAnswerSetComplete([answer()])).toBe(true);
    expect(isAnswerSetComplete([answer({ finalValue: null })])).toBe(false);
    expect(
      isAnswerSetComplete([
        answer({ field: { ...answer().field, required: false }, finalValue: null }),
      ]),
    ).toBe(true);
    expect(
      isAnswerSetComplete([
        answer({ decision: "requires_user", finalValue: null, finalValueSetBy: null }),
      ]),
    ).toBe(false);
    expect(
      isAnswerSetComplete([answer({ decision: "requires_user", finalValueSetBy: "system" })]),
    ).toBe(false);
    expect(
      isAnswerSetComplete([
        answer({ decision: "prohibited", finalValue: null, finalValueSetBy: null }),
      ]),
    ).toBe(true);
  });
});
