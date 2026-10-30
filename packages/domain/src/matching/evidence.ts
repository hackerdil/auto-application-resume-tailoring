import type { VerifiedFact } from "../schemas/fact.js";
import type { RequirementAssessment, RequirementStatus } from "../schemas/match.js";
import type { Job } from "../schemas/job.js";
import { coverage, tokenSet, yearsRequired } from "./text.js";

export interface RequirementInput {
  key: string;
  text: string;
  kind: RequirementAssessment["kind"];
}

/** Requirement list with stable keys: required items first (R1..), then preferred, in posting order. */
export function requirementsFromJob(
  job: Pick<Job, "requiredQualifications" | "preferredQualifications">,
): RequirementInput[] {
  const out: RequirementInput[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: RequirementInput["kind"]) => {
    const t = text.trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k) || out.length >= 60) return;
    seen.add(k);
    out.push({ key: `R${out.length + 1}`, text: t.slice(0, 1000), kind });
  };
  job.requiredQualifications.forEach((t) => {
    add(t, "required");
  });
  job.preferredQualifications.forEach((t) => {
    add(t, "preferred");
  });
  return out;
}

/** Facts eligible for matching: active and not sensitive (sensitive facts never feed scoring or prompts). */
export function matchableFacts(facts: readonly VerifiedFact[]): VerifiedFact[] {
  return facts.filter((f) => !f.sensitive && !f.supersededBy);
}

const MET = 0.6;
const PARTIAL = 0.34;

/**
 * Lexical evidence: share of the requirement's content tokens found in a fact. Conservative by design:
 * stated years of experience cannot be verified from facts, so such requirements are at most "partial".
 */
/**
 * "Go or Rust", "AWS/GCP": short alternatives are satisfied by any one of them. Longer "or" clauses are left
 * whole, because splitting prose would loosen the requirement.
 */
export function alternatives(text: string): Set<string>[] {
  const whole = tokenSet(text);
  const parts = text
    .split(/\s+or\s+|\s*\/\s*(?=[A-Za-z])/i)
    .map((p) => tokenSet(p))
    .filter((s) => s.size > 0);
  if (parts.length < 2 || parts.some((p) => p.size > 4)) return [whole];
  return parts;
}

export function lexicalAssessment(
  req: RequirementInput,
  facts: readonly VerifiedFact[],
): RequirementAssessment {
  const need = tokenSet(req.text);
  const alts = alternatives(req.text);
  const scored = facts
    .map((f) => {
      const have = tokenSet(f.claim);
      return { f, c: Math.max(...alts.map((a) => coverage(a, have))) };
    })
    .filter((x) => x.c >= PARTIAL)
    .sort((a, b) => b.c - a.c || a.f.id.localeCompare(b.f.id));
  const best = scored[0]?.c ?? 0;
  const years = yearsRequired(req.text);
  let status: RequirementStatus =
    best >= MET ? "met" : best >= PARTIAL ? "partial" : need.size === 0 ? "unknown" : "missing";
  let rationale =
    status === "met"
      ? "Your facts mention the key terms of this requirement."
      : status === "partial"
        ? "Your facts mention some of this requirement's terms."
        : status === "unknown"
          ? "This requirement has no specific terms to check."
          : "No fact in your fact bank mentions this.";
  if (years !== null && status === "met") {
    status = "partial";
    rationale = `Related facts found, but ${years}+ years of experience cannot be verified from your fact bank.`;
  }
  return {
    key: req.key,
    text: req.text,
    kind: req.kind,
    status,
    factIds: status === "met" || status === "partial" ? scored.slice(0, 3).map((x) => x.f.id) : [],
    source: "lexical",
    rationale,
  };
}
