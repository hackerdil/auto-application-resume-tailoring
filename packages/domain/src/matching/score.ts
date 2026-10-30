import type { VerifiedFact } from "../schemas/fact.js";
import type { Job } from "../schemas/job.js";
import type {
  DimensionScore,
  MatchDimension,
  MatchVerdict,
  MatchWeights,
  RequirementAssessment,
} from "../schemas/match.js";
import type { Preferences } from "../schemas/profile.js";
import {
  coverage,
  SENIORITY_RANK,
  seniorityFromTitle,
  tokens,
  tokenSet,
  type SeniorityLevel,
} from "./text.js";

export interface ScoreInput {
  job: Job;
  requirements: readonly RequirementAssessment[];
  facts: readonly VerifiedFact[];
  prefs: Preferences | null;
  /** The owner's explicit saved answer to "Do you require visa sponsorship?"; null when never answered. */
  needsSponsorship: boolean | null;
  weights: MatchWeights;
  /** MATCH_SCORE_THRESHOLD: totals at or above it are "strong". */
  strongThreshold: number;
}

export interface ScoreOutput {
  total: number;
  dimensions: Record<MatchDimension, DimensionScore>;
  verdict: MatchVerdict;
  hardFilterReasons: string[];
  unknowns: string[];
  missing: string[];
  explanation: string;
}

const STATUS_VALUE: Record<RequirementAssessment["status"], number> = {
  met: 1,
  partial: 0.5,
  unknown: 0.25,
  missing: 0,
};
const known = (score: number, rationale: string): DimensionScore => ({
  score: Math.round(Math.max(0, Math.min(100, score))),
  rationale,
  unknown: false,
});
const unknownDim = (rationale: string): DimensionScore => ({ score: 50, rationale, unknown: true });

function requirementScore(reqs: readonly RequirementAssessment[], label: string): DimensionScore {
  if (reqs.length === 0)
    return unknownDim(`The posting lists no ${label} in a recognizable section.`);
  const v = reqs.reduce((a, r) => a + STATUS_VALUE[r.status], 0) / reqs.length;
  const met = reqs.filter((r) => r.status === "met").length;
  const partial = reqs.filter((r) => r.status === "partial").length;
  return known(
    v * 100,
    `${met} of ${reqs.length} ${label} met and ${partial} partly met, based on your verified facts.`,
  );
}

function candidateSeniority(facts: readonly VerifiedFact[]): SeniorityLevel {
  let best: SeniorityLevel = "unknown";
  for (const f of facts) {
    if (f.category !== "role" && f.category !== "employment") continue;
    const s = seniorityFromTitle(f.claim);
    if (s !== "unknown" && (best === "unknown" || SENIORITY_RANK[s] > SENIORITY_RANK[best]))
      best = s;
  }
  return best;
}

/**
 * Deterministic, explainable aggregation (spec §11 Match result). Each dimension is 0–100 with a rationale;
 * missing information yields a neutral 50 marked `unknown` and listed for the owner to confirm.
 */
export function scoreMatch(input: ScoreInput): ScoreOutput {
  const { job, prefs, facts } = input;
  const unknowns: string[] = [];
  const hardFilterReasons = [...job.filterReasons];
  const d = {} as Record<MatchDimension, DimensionScore>;

  // Role alignment: how much of the best-matching target role appears in the title.
  if (prefs && prefs.targetRoles.length > 0) {
    const title = tokenSet(job.title);
    const best = Math.max(...prefs.targetRoles.map((r) => coverage(tokenSet(r), title)));
    const role = prefs.targetRoles.find((r) => coverage(tokenSet(r), title) === best) ?? "";
    d.roleAlignment = known(
      best * 100,
      best > 0
        ? `The title "${job.title}" matches ${Math.round(best * 100)}% of your target role "${role}".`
        : `The title "${job.title}" does not match your target roles.`,
    );
  } else {
    d.roleAlignment = unknownDim("You have not set target roles.");
    unknowns.push("Add target roles in your profile to score role alignment.");
  }

  const required = input.requirements.filter((r) => r.kind === "required");
  d.mustHaveSkills = requirementScore(required, "listed requirements");
  d.experienceEvidence = requirementScore(
    input.requirements,
    "listed requirements and nice-to-haves",
  );

  const cand = candidateSeniority(facts);
  if (job.seniority === "unknown" || cand === "unknown") {
    d.seniorityAlignment = unknownDim(
      job.seniority === "unknown"
        ? "The title does not state a seniority level."
        : "Your role facts do not state a seniority level.",
    );
  } else {
    const gap = Math.abs(SENIORITY_RANK[job.seniority] - SENIORITY_RANK[cand]);
    d.seniorityAlignment = known(
      [100, 70, 40, 10][Math.min(gap, 3)] ?? 10,
      `The job is ${job.seniority}; your most senior role fact is ${cand}.`,
    );
  }

  // Domain alignment: lexical overlap between the posting's most frequent terms and your fact bank.
  const freq = new Map<string, number>();
  for (const t of tokens(job.descriptionText)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const top = new Set(
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([t]) => t),
  );
  const factTokens = new Set(facts.flatMap((f) => tokens(f.claim)));
  if (top.size < 5 || factTokens.size === 0) {
    d.domainAlignment = unknownDim(
      top.size < 5 ? "The description is too short to compare." : "Your fact bank is empty.",
    );
  } else {
    const c = coverage(top, factTokens);
    d.domainAlignment = known(
      Math.min(100, c * 250),
      `${Math.round(c * 100)}% of the posting's most frequent terms appear in your facts (word overlap, not a judgment of fit).`,
    );
  }

  // Location / work mode.
  if (!prefs || (prefs.workModes.length === 0 && prefs.locations.length === 0)) {
    d.locationFit = unknownDim("You have not set location or work-mode preferences.");
  } else if (job.workMode === "unknown" && job.locations.length === 0) {
    d.locationFit = unknownDim("The posting does not state location or work mode.");
    unknowns.push("Check the posting's location and work mode.");
  } else {
    const modeOk =
      prefs.workModes.length === 0 ||
      job.workMode === "unknown" ||
      prefs.workModes.includes(job.workMode);
    d.locationFit = known(
      modeOk ? (job.workMode === "unknown" ? 70 : 100) : 0,
      modeOk
        ? `Work mode "${job.workMode}" and location fit your preferences.`
        : `Work mode "${job.workMode}" is outside your preferences.`,
    );
  }

  // Authorization / sponsorship: only explicit answers count; nothing is inferred.
  if (input.needsSponsorship === null) {
    d.authorizationFit = unknownDim("You have not saved whether you need visa sponsorship.");
    if (job.sponsorship.value === "not_offered")
      unknowns.push(
        "This posting does not offer sponsorship. Save an answer to “Do you require visa sponsorship?” so this can be checked.",
      );
  } else if (!input.needsSponsorship) {
    d.authorizationFit = known(100, "You saved that you do not need sponsorship.");
  } else if (job.sponsorship.value === "offered") {
    d.authorizationFit = known(100, "You need sponsorship and the posting says it is available.");
  } else if (job.sponsorship.value === "not_offered") {
    d.authorizationFit = known(0, "You need sponsorship and the posting says it is not offered.");
    hardFilterReasons.push(
      "authorization: the posting does not offer visa sponsorship, which you said you need",
    );
  } else {
    d.authorizationFit = unknownDim(
      "You need sponsorship and the posting does not say whether it is offered.",
    );
    unknowns.push("Ask the employer whether visa sponsorship is available.");
  }

  // Compensation.
  const want = prefs?.compensation ?? null;
  const offer = job.compensation;
  if (!want || !offer) {
    d.compensationFit = unknownDim(
      !offer
        ? "The posting does not state compensation."
        : "You have not set a compensation preference.",
    );
  } else if (want.currency !== offer.currency || want.period !== offer.period) {
    d.compensationFit = unknownDim(
      `Compensation is in ${offer.currency}/${offer.period}; your preference is in ${want.currency}/${want.period}.`,
    );
  } else {
    const top = offer.max ?? offer.min ?? 0;
    const floor = want.min ?? 0;
    d.compensationFit =
      top >= floor
        ? known(100, "The stated range reaches your minimum.")
        : known(
            Math.max(0, (top / Math.max(floor, 1)) * 100 - 20),
            "The stated range is below your minimum.",
          );
  }

  // Preferences: exclusions already filter; here, employment type and the absence of conflicts.
  const conflicts = job.filterReasons.filter((r) =>
    /^(excluded_company|excluded_role|work_mode|location|compensation_below_minimum)/.test(r),
  );
  d.preferenceFit = prefs
    ? known(
        conflicts.length ? 0 : 100,
        conflicts.length
          ? `Conflicts with your preferences: ${conflicts.join("; ")}.`
          : "No conflicts with your stated exclusions.",
      )
    : unknownDim("You have not saved preferences.");

  let total = 0;
  for (const [k, w] of Object.entries(input.weights) as [MatchDimension, number][])
    total += w * d[k].score;
  total = Math.round(total);

  const missing = input.requirements
    .filter((r) => r.status === "missing" && r.kind === "required")
    .map((r) => r.text);
  // "strong" needs real evidence: requirement coverage must be known and solid, not carried by neutral unknowns.
  const evidenced = !d.mustHaveSkills.unknown && d.mustHaveSkills.score >= 60;
  const verdict: MatchVerdict = hardFilterReasons.length
    ? "disqualified"
    : total >= input.strongThreshold && evidenced
      ? "strong"
      : total >= 50
        ? "possible"
        : "weak";
  const met = input.requirements.filter((r) => r.status === "met").length;
  const explanation = [
    `Internal relevance score ${total}/100 (${verdict}). This is not an employer ATS score or a prediction of hiring.`,
    input.requirements.length
      ? `Of ${input.requirements.length} listed requirements and nice-to-haves, ${met} are fully and ${input.requirements.filter((r) => r.status === "partial").length} partly supported by your verified facts.`
      : "The posting lists no requirements in a recognizable section.",
    missing.length
      ? `Not found in your facts: ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "…" : ""}.`
      : "",
    hardFilterReasons.length ? `Disqualified: ${hardFilterReasons.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);

  return { total, dimensions: d, verdict, hardFilterReasons, unknowns, missing, explanation };
}
