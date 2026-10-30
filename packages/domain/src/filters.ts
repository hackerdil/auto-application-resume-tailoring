import type { Job } from "./schemas/job.js";
import type { Preferences } from "./schemas/profile.js";

export interface FilterContext {
  now: Date;
  freshnessDays: number;
  /** Canonical id of an already-known job with identical content, if any. */
  duplicateOf: string | null;
}

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const containsPhrase = (haystack: string, phrase: string) => {
  const p = fold(phrase);
  return p.length > 0 && ` ${fold(haystack)} `.includes(` ${p} `);
};

/**
 * Deterministic hard filters (spec §15 step 6, §32 Phase 3). Each reason is `code: detail`.
 * Unknown job attributes never cause a filter: missing information is a matter for scoring, not exclusion.
 * Protected characteristics are not inputs.
 */
export function applyHardFilters(
  job: Job,
  prefs: Preferences | null,
  ctx: FilterContext,
): string[] {
  const reasons: string[] = [];
  if (ctx.duplicateOf) reasons.push(`duplicate: same posting as ${ctx.duplicateOf}`);

  if (job.postedAt) {
    const ageDays = (ctx.now.getTime() - Date.parse(job.postedAt)) / 86_400_000;
    if (ageDays > ctx.freshnessDays)
      reasons.push(`stale: posted ${Math.floor(ageDays)} days ago (limit ${ctx.freshnessDays})`);
  }

  if (!prefs) return reasons;

  const company = prefs.excludedCompanies.find((c) => fold(c) === fold(job.company));
  if (company) reasons.push(`excluded_company: ${job.company}`);

  const role = prefs.excludedRoles.find((r) => containsPhrase(job.title, r));
  if (role) reasons.push(`excluded_role: title contains "${role}"`);

  if (
    prefs.workModes.length > 0 &&
    job.workMode !== "unknown" &&
    !prefs.workModes.includes(job.workMode)
  ) {
    reasons.push(
      `work_mode: ${job.workMode} is not in your preferences (${prefs.workModes.join(", ")})`,
    );
  }

  if (prefs.locations.length > 0 && job.workMode !== "remote" && job.locations.length > 0) {
    const ok = job.locations.some((loc) =>
      prefs.locations.some((p) => containsPhrase(loc, p) || containsPhrase(p, loc)),
    );
    if (!ok && !job.locations.some((l) => /\bremote\b/i.test(l))) {
      reasons.push(`location: ${job.locations.join("; ")} does not match your locations`);
    }
  }

  const want = prefs.compensation;
  const offer = job.compensation;
  if (
    want?.min != null &&
    offer?.max != null &&
    want.currency === offer.currency &&
    want.period === offer.period &&
    offer.max < want.min
  ) {
    reasons.push(
      `compensation_below_minimum: up to ${offer.max} ${offer.currency}/${offer.period}, your minimum is ${want.min}`,
    );
  }
  return reasons;
}
