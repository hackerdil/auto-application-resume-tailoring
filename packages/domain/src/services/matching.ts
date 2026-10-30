import { createHash } from "node:crypto";
import { BudgetExceededError, CareerAgentError, NotFoundError, PolicyError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { lexicalAssessment, matchableFacts, requirementsFromJob } from "../matching/evidence.js";
import { mergeModelJudgments, type ModelJudgment } from "../matching/model-judgments.js";
import { scoreMatch } from "../matching/score.js";
import type {
  AuditRepository,
  FactRepository,
  JobRepository,
  JobRequirementRepository,
  MatchRepository,
  ProfileRepository,
  ProviderRunRecord,
  ProviderRunRepository,
  SavedAnswerRepository,
} from "../repositories.js";
import { RunBudget } from "../run-budget.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { Job, JobStatus } from "../schemas/job.js";
import {
  DEFAULT_MATCH_WEIGHTS,
  MatchResult,
  type MatchWeights,
  type RequirementAssessment,
} from "../schemas/match.js";
import type { RunLimits } from "../schemas/run.js";
import { normalizeQuestion } from "./profile.js";

export const SCORE_JOB_TASK = "score_job";
export const scoreKeyPrefix = (jobId: string): string => `score:${jobId}:`;
export const SCORING_VERSION = "match-v1";
export const SPONSORSHIP_QUESTION = "Do you require visa sponsorship?";

/** Model step behind a port: implemented in @career-agent/ai, absent until a provider is configured. */
export interface MatchAnalyzer {
  readonly provider: string;
  analyze(
    input: {
      job: Pick<Job, "id" | "title" | "company" | "descriptionText">;
      requirements: { key: string; text: string; kind: string }[];
      facts: { id: string; category: string; claim: string }[];
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{
    judgments: ModelJudgment[];
    explanation: string;
    promptId: string;
    promptVersion: string;
    model: string | null;
    runs: ProviderRunRecord[];
  }>;
}

export interface MatchingDeps {
  jobs: JobRepository;
  facts: FactRepository;
  profiles: ProfileRepository;
  savedAnswers: SavedAnswerRepository;
  matches: MatchRepository;
  requirements: JobRequirementRepository;
  providerRuns: ProviderRunRepository;
  audit: AuditRepository;
  strongThreshold: number;
  analyzer?: MatchAnalyzer | null;
  /** Limits for one job's model call (spec §4.5). */
  limits?: RunLimits;
  now?: () => Date;
}

const SCORABLE: ReadonlySet<JobStatus> = new Set(["ELIGIBLE", "SCORED", "SHORTLISTED", "SKIPPED"]);

export const DEFAULT_MATCH_LIMITS: RunLimits = {
  deadlineMs: 120_000,
  maxModelTurns: 2,
  maxToolCalls: 0,
  maxBrowserSteps: 0,
  maxRetries: 1,
  maxInputChars: 40_000,
  maxOutputTokens: 4_000,
  maxCostUsd: 0.25,
};

/** Hash of everything a score depends on; a different hash means the stored score is stale. */
export function matchInputsHash(
  job: Pick<Job, "contentHash" | "filterReasons">,
  facts: readonly VerifiedFact[],
  profileVersion: number,
  weights: MatchWeights,
  sponsorship: boolean | null,
): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      c: job.contentHash,
      f: job.filterReasons,
      facts: facts.map((x) => x.id).sort(),
      p: profileVersion,
      w: weights,
      s: sponsorship,
      v: SCORING_VERSION,
    }),
  );
  return h.digest("hex");
}

/** Strict reading of the owner's explicit answer; anything ambiguous stays unknown. */
export function parseYesNo(value: string | undefined | null): boolean | null {
  const v = (value ?? "").trim().toLowerCase();
  if (/^(yes|y|true)\b/.test(v)) return true;
  if (/^(no|n|false)\b/.test(v)) return false;
  return null;
}

/** Match Analyst (spec §9): evidence-backed, deterministic scoring with an optional, validated model step. */
export class MatchingService {
  private readonly now: () => Date;

  constructor(private readonly d: MatchingDeps) {
    this.now = d.now ?? (() => new Date());
  }

  inputsFor(ownerId: string, job: Job) {
    const profile = this.d.profiles.get(ownerId);
    const facts = matchableFacts(this.d.facts.listActive(ownerId));
    const weights = DEFAULT_MATCH_WEIGHTS;
    const needsSponsorship = parseYesNo(
      this.d.savedAnswers.findActive(ownerId, normalizeQuestion(SPONSORSHIP_QUESTION))?.value,
    );
    const profileVersion = profile?.version ?? 0;
    return {
      profile,
      facts,
      weights,
      needsSponsorship,
      profileVersion,
      inputsHash: matchInputsHash(job, facts, profileVersion, weights, needsSponsorship),
    };
  }

  isStale(ownerId: string, job: Job, match: MatchResult): boolean {
    return this.inputsFor(ownerId, job).inputsHash !== match.meta.inputsHash;
  }

  /** Stale check for many jobs, loading the owner's profile and facts once. */
  staleChecker(ownerId: string): (job: Job, match: MatchResult) => boolean {
    const profile = this.d.profiles.get(ownerId);
    const facts = matchableFacts(this.d.facts.listActive(ownerId));
    const sponsorship = parseYesNo(
      this.d.savedAnswers.findActive(ownerId, normalizeQuestion(SPONSORSHIP_QUESTION))?.value,
    );
    return (job, match) =>
      matchInputsHash(job, facts, profile?.version ?? 0, DEFAULT_MATCH_WEIGHTS, sponsorship) !==
      match.meta.inputsHash;
  }

  async scoreJob(jobId: string, ownerId: string, traceId: string): Promise<MatchResult> {
    const job = this.d.jobs.get(jobId);
    if (!job) throw new NotFoundError("Job not found.");
    if (!SCORABLE.has(job.status))
      throw new PolicyError(
        `Only eligible jobs are scored (this job is ${job.status.toLowerCase()}).`,
      );
    const inputs = this.inputsFor(ownerId, job);
    const reqInputs = requirementsFromJob(job);
    this.d.requirements.replaceForJob(
      job.id,
      reqInputs.map((r) => ({ ...r, evidence: null })),
    );

    let requirements: RequirementAssessment[] = reqInputs.map((r) =>
      lexicalAssessment(r, inputs.facts),
    );
    let modelExplanation: string | null = null;
    let modelMeta = {
      promptId: null as string | null,
      promptVersion: null as string | null,
      provider: null as string | null,
      model: null as string | null,
      costUsd: null as number | null,
    };
    let modelSkippedReason: string | null = this.d.analyzer
      ? null
      : "No AI provider is configured; scored with deterministic evidence only.";
    let corrections: string[] = [];

    if (this.d.analyzer && reqInputs.length > 0) {
      const budget = new RunBudget(this.d.limits ?? DEFAULT_MATCH_LIMITS);
      try {
        const out = await this.d.analyzer.analyze(
          {
            job,
            requirements: reqInputs,
            facts: inputs.facts.map((f) => ({ id: f.id, category: f.category, claim: f.claim })),
          },
          { budget, traceId },
        );
        for (const run of out.runs) this.d.providerRuns.record(run);
        const merged = mergeModelJudgments(
          requirements,
          out.judgments,
          new Set(inputs.facts.map((f) => f.id)),
        );
        requirements = merged.requirements;
        corrections = merged.corrections;
        modelExplanation = out.explanation.slice(0, 1200) || null;
        const cost = out.runs.reduce<number | null>(
          (a, r) => (r.costUsd === null ? a : (a ?? 0) + r.costUsd),
          null,
        );
        modelMeta = {
          promptId: out.promptId,
          promptVersion: out.promptVersion,
          provider: this.d.analyzer.provider,
          model: out.model,
          costUsd: cost,
        };
      } catch (err) {
        modelSkippedReason =
          err instanceof BudgetExceededError
            ? `The AI step stopped at its ${err.limit} limit; scored with deterministic evidence only.`
            : `The AI step failed (${err instanceof CareerAgentError ? err.code : "error"}); scored with deterministic evidence only.`;
      }
    } else if (this.d.analyzer) {
      modelSkippedReason = "The posting lists no requirements to assess.";
    }

    const s = scoreMatch({
      job,
      requirements,
      facts: inputs.facts,
      prefs: inputs.profile?.preferences ?? null,
      needsSponsorship: inputs.needsSponsorship,
      weights: inputs.weights,
      strongThreshold: this.d.strongThreshold,
    });
    const result = MatchResult.parse({
      id: uuidv7(),
      jobId: job.id,
      profileVersion: inputs.profileVersion,
      total: s.total,
      dimensions: s.dimensions,
      verdict: s.verdict,
      requirements,
      matched: requirements
        .filter((r) => r.status === "met" || r.status === "partial")
        .map((r) => ({ requirementKey: r.key, factIds: r.factIds })),
      missing: s.missing,
      unknowns: [
        ...s.unknowns,
        ...requirements
          .filter((r) => r.status === "unknown")
          .map((r) => `Requirement ${r.key}: ${r.text}`),
      ].slice(0, 50),
      hardFilterReasons: s.hardFilterReasons,
      explanation: s.explanation,
      modelExplanation,
      createdAt: this.now().toISOString(),
      meta: {
        scoringVersion: SCORING_VERSION,
        mode: modelMeta.provider ? "model-assisted" : "deterministic",
        inputsHash: inputs.inputsHash,
        weights: inputs.weights,
        ...modelMeta,
        modelSkippedReason,
      },
    });
    this.d.matches.save(result);
    if (job.status === "ELIGIBLE" || job.status === "SCORED")
      this.d.jobs.transition(job.id, "SCORED", { traceId, actor: "system" });
    this.d.audit.append({
      traceId,
      runId: null,
      taskId: null,
      applicationId: null,
      jobId: job.id,
      actor: "system",
      type: "match.scored",
      prevState: null,
      newState: null,
      approvalId: null,
      artifactHashes: [],
      provider: modelMeta.provider,
      model: modelMeta.model,
      durationMs: null,
      metadata: {
        total: s.total,
        verdict: s.verdict,
        mode: result.meta.mode,
        corrections: corrections.length,
        modelSkipped: modelSkippedReason !== null,
      },
    });
    return result;
  }
}
