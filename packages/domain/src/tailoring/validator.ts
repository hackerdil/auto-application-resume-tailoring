import type { VerifiedFact } from "../schemas/fact.js";
import type { FactTransformation } from "../schemas/fact.js";
import type { VerifierFinding } from "../schemas/resume.js";
import { tokens } from "../matching/text.js";

/**
 * Words a rephrased bullet may introduce without evidence: neutral verbs and connectors. Words implying scope,
 * leadership, scale, impact, or causation are deliberately absent.
 */
const NEUTRAL = new Set(
  (
    "built build developed develop designed design implemented implement created create delivered deliver improved " +
    "improve maintained maintain supported support wrote write shipped ship launched launch migrated migrate automated " +
    "automate optimized optimize reduced reduce increased increase owned own worked work collaborated collaborate " +
    "contributed contribute introduced introduce refactored refactor tested test deployed deploy operated operate " +
    "monitored monitor documented document analyzed analyze prototyped prototype set up configured configure ran run " +
    "service system application platform product feature internal external customer user across within end-to-end " +
    "daily weekly time new existing production codebase code"
  ).split(" "),
);

const LEADERSHIP =
  /\b(led|lead|leading|managed|manage|headed|directed|supervised|mentored|oversaw|spearheaded|architected|owned the)\b/i;
const CAUSAL =
  /\b(resulting in|resulted in|leading to|led to|which (increased|reduced|improved|cut|saved|grew)|thereby|due to|so that|contributing to|drove|enabled)\b/i;
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

/** Numbers stated in a text, normalized ("1,200" → 1200, "12k" → 12000, "1.5M" → 1500000, "five" → 5). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(
    /(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn|b|million|billion|thousand)?\b/gi,
  )) {
    let v = Number((m[1] ?? "").replace(/,/g, ""));
    const suf = (m[2] ?? "").toLowerCase();
    if (suf === "k" || suf === "thousand") v *= 1000;
    else if (suf === "m" || suf === "million") v *= 1_000_000;
    else if (suf === "b" || suf === "bn" || suf === "billion") v *= 1_000_000_000;
    if (Number.isFinite(v)) out.add(v);
  }
  for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const v = NUMBER_WORDS[w];
    if (v !== undefined) out.add(v);
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const crit = (kind: VerifierFinding["kind"], detail: string): VerifierFinding => ({
  severity: "critical",
  kind,
  detail,
});

export interface BulletDraft {
  text: string;
  sourceFactIds: readonly string[];
  transformation: FactTransformation;
}

export interface ValidationContext {
  facts: ReadonlyMap<string, VerifiedFact>;
  /** When validating an experience bullet: the facts that belong to that role (prevents misattribution). */
  allowedForEntry?: ReadonlySet<string>;
}

/**
 * Deterministic no-drift validator (spec §15 step 8, §4.1). A bullet passes only when every number, entity,
 * tool, credential, scale, leadership and causal claim is supported by the facts it cites, the cited facts permit
 * the transformation used, and they belong to the entry the bullet is placed under.
 */
export function validateBullet(b: BulletDraft, ctx: ValidationContext): VerifierFinding[] {
  const findings: VerifierFinding[] = [];
  const cited = [...new Set(b.sourceFactIds)].map((id) => ctx.facts.get(id));
  if (cited.length === 0) return [crit("missing_provenance", "The bullet cites no facts.")];
  if (cited.some((f) => f === undefined))
    findings.push(
      crit("missing_provenance", "The bullet cites a fact that is not in your verified fact bank."),
    );
  const facts = cited.filter((f): f is VerifiedFact => f !== undefined);
  if (facts.length === 0) return findings;

  if (ctx.allowedForEntry) {
    const foreign = facts.filter((f) => !ctx.allowedForEntry?.has(f.id));
    if (foreign.length)
      findings.push(
        crit(
          "chronology_mismatch",
          "The bullet uses facts from a different role than the one it is listed under.",
        ),
      );
  }

  for (const f of facts) {
    if (!f.allowedTransformations.includes(b.transformation)) {
      findings.push(
        crit(
          "other",
          `A cited fact does not allow "${b.transformation}" (allowed: ${f.allowedTransformations.join(", ")}).`,
        ),
      );
    }
  }
  const source = facts.map((f) => f.claim).join(" \n ");
  if (
    (b.transformation === "select" || b.transformation === "reorder") &&
    !facts.some((f) => norm(f.claim) === norm(b.text))
  ) {
    findings.push(crit("other", `"${b.transformation}" must reproduce the fact verbatim.`));
  }
  if (b.transformation === "combine" && facts.length < 2)
    findings.push(crit("other", '"combine" must cite at least two facts.'));
  if (
    b.transformation === "shorten" &&
    b.text.length > Math.max(...facts.map((f) => f.claim.length))
  ) {
    findings.push(crit("other", '"shorten" produced a longer text than the fact.'));
  }

  const have = numbersIn(source);
  const extraNumbers = [...numbersIn(b.text)].filter((n) => !have.has(n));
  if (extraNumbers.length)
    findings.push(
      crit("unsupported_number", `Numbers not in the cited facts: ${extraNumbers.join(", ")}.`),
    );

  const factTokens = new Set(tokens(source));
  const original = new Map<string, string>();
  for (const w of b.text.match(/[A-Za-z0-9][\w+#./-]*/g) ?? [])
    for (const t of tokens(w)) if (!original.has(t)) original.set(t, w);
  const extra = [...new Set(tokens(b.text))].filter(
    (t) => !factTokens.has(t) && !NEUTRAL.has(t) && !/^\d/.test(t),
  );
  const entities = extra.filter((t) => /^[A-Z]/.test(original.get(t) ?? ""));
  const terms = extra.filter((t) => !entities.includes(t));
  if (entities.length)
    findings.push(
      crit(
        "unsupported_entity",
        `Names not in the cited facts: ${entities.map((t) => original.get(t) ?? t).join(", ")}.`,
      ),
    );
  if (terms.length)
    findings.push(
      crit(
        "unsupported_tool",
        `Terms not in the cited facts (tools, skills, scope, or claims): ${terms.map((t) => original.get(t) ?? t).join(", ")}.`,
      ),
    );

  if (LEADERSHIP.test(b.text) && !LEADERSHIP.test(source))
    findings.push(
      crit(
        "unsupported_scope",
        "Leadership or ownership is claimed but not stated in the cited facts.",
      ),
    );
  if (CAUSAL.test(b.text) && !CAUSAL.test(source))
    findings.push(
      crit(
        "unsupported_causal_claim",
        "A cause-and-effect claim is made that the cited facts do not state.",
      ),
    );
  return findings;
}
