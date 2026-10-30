import { z } from "zod";
import { Id, IsoDateTime, Sha256Hex } from "./common.js";
import { CanonicalJobId, RequirementKind } from "./job.js";

export const MatchDimension = z.enum([
  "roleAlignment",
  "mustHaveSkills",
  "experienceEvidence",
  "seniorityAlignment",
  "domainAlignment",
  "locationFit",
  "authorizationFit",
  "compensationFit",
  "preferenceFit",
]);
export type MatchDimension = z.infer<typeof MatchDimension>;

export const MatchWeights = z
  .record(MatchDimension, z.number().min(0).max(1))
  .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-6, {
    message: "weights must sum to 1",
  });
export type MatchWeights = z.infer<typeof MatchWeights>;

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  roleAlignment: 0.15,
  mustHaveSkills: 0.2,
  experienceEvidence: 0.2,
  seniorityAlignment: 0.1,
  domainAlignment: 0.08,
  locationFit: 0.1,
  authorizationFit: 0.07,
  compensationFit: 0.05,
  preferenceFit: 0.05,
};

export const DimensionScore = z.object({
  score: z.number().min(0).max(100),
  rationale: z.string().max(1000),
  /** True when the score is a neutral placeholder because information is missing. */
  unknown: z.boolean().default(false),
});
export type DimensionScore = z.infer<typeof DimensionScore>;

export const MatchVerdict = z.enum(["strong", "possible", "weak", "disqualified"]);
export type MatchVerdict = z.infer<typeof MatchVerdict>;

export const RequirementStatus = z.enum(["met", "partial", "missing", "unknown"]);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

/** One job requirement and the evidence for it. Every "met"/"partial" status cites at least one verified fact. */
export const RequirementAssessment = z
  .object({
    key: z.string().regex(/^R\d{1,3}$/),
    text: z.string().min(1).max(1000),
    kind: RequirementKind,
    status: RequirementStatus,
    factIds: z.array(Id),
    source: z.enum(["lexical", "model"]),
    rationale: z.string().max(600),
  })
  .refine((r) => (r.status === "met" || r.status === "partial" ? r.factIds.length > 0 : true), {
    message: "met/partial requirements must cite at least one fact",
  });
export type RequirementAssessment = z.infer<typeof RequirementAssessment>;

/**
 * Spec §11. `total` is an internal relevance heuristic — never an ATS score or hiring prediction.
 * Protected characteristics never influence any dimension.
 */
export const MatchResult = z.object({
  id: Id,
  jobId: CanonicalJobId,
  /** 0 when no profile has been saved yet. */
  profileVersion: z.number().int().nonnegative(),
  total: z.number().min(0).max(100),
  dimensions: z.record(MatchDimension, DimensionScore),
  verdict: MatchVerdict,
  requirements: z.array(RequirementAssessment),
  matched: z.array(z.object({ requirementKey: z.string(), factIds: z.array(Id).min(1) })),
  missing: z.array(z.string()),
  unknowns: z.array(z.string()),
  hardFilterReasons: z.array(z.string()),
  explanation: z.string().max(2000),
  /** Model-written summary, shown separately and labelled; never used for the score. */
  modelExplanation: z.string().max(1200).nullable(),
  createdAt: IsoDateTime,
  meta: z.object({
    scoringVersion: z.string(),
    mode: z.enum(["deterministic", "model-assisted"]),
    /** Hash of the active fact ids and job content used, to detect stale scores. */
    inputsHash: Sha256Hex,
    weights: MatchWeights,
    promptId: z.string().nullable(),
    promptVersion: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    /** Why the model was not used, when it was not. */
    modelSkippedReason: z.string().nullable(),
  }),
});
export type MatchResult = z.infer<typeof MatchResult>;
