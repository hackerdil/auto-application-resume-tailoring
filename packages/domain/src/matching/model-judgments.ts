import type { RequirementAssessment, RequirementStatus } from "../schemas/match.js";

/** Shape of a model's per-requirement judgment (validated with Zod in @career-agent/ai before reaching here). */
export interface ModelJudgment {
  key: string;
  status: RequirementStatus;
  factIds: string[];
  rationale: string;
}

export interface MergeReport {
  requirements: RequirementAssessment[];
  /** Judgments that were rejected or downgraded, with reasons (shown in the audit trail and tests). */
  corrections: string[];
}

/**
 * Applies a model's judgments on top of lexical evidence — the deterministic validator is the gate (spec §4.1):
 * - unknown requirement keys are ignored;
 * - cited fact ids must be among the facts the model was shown, otherwise they are dropped;
 * - "met"/"partial" without any valid citation becomes "unknown";
 * - a model may not mark a requirement met when it states years of experience the facts cannot prove (kept "partial").
 */
export function mergeModelJudgments(
  lexical: readonly RequirementAssessment[],
  judgments: readonly ModelJudgment[],
  allowedFactIds: ReadonlySet<string>,
): MergeReport {
  const corrections: string[] = [];
  const byKey = new Map<string, ModelJudgment>();
  for (const j of judgments) {
    if (!lexical.some((r) => r.key === j.key)) {
      corrections.push(`${j.key}: unknown requirement key ignored`);
      continue;
    }
    if (!byKey.has(j.key)) byKey.set(j.key, j);
  }
  const requirements = lexical.map((r): RequirementAssessment => {
    const j = byKey.get(r.key);
    if (!j) return r;
    const valid = [...new Set(j.factIds)].filter((id) => allowedFactIds.has(id));
    if (valid.length < j.factIds.length)
      corrections.push(
        `${r.key}: dropped ${j.factIds.length - valid.length} citation(s) to facts the model was not given`,
      );
    let status = j.status;
    if ((status === "met" || status === "partial") && valid.length === 0) {
      corrections.push(`${r.key}: "${status}" without valid evidence downgraded to "unknown"`);
      status = "unknown";
    }
    if (status === "met" && /\d+\s*\+?\s*(years|yrs)\b/i.test(r.text)) {
      corrections.push(
        `${r.key}: years of experience cannot be verified from facts; kept as "partial"`,
      );
      status = "partial";
    }
    return {
      ...r,
      status,
      factIds: status === "met" || status === "partial" ? valid.slice(0, 5) : [],
      source: "model",
      rationale: j.rationale.slice(0, 600),
    };
  });
  return { requirements, corrections };
}
