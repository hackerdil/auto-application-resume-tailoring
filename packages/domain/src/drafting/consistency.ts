import type { ApplicationAnswer } from "../schemas/application.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { Job } from "../schemas/job.js";
import type { CandidateProfile } from "../schemas/profile.js";
import type { CoverLetter, TailoredResume } from "../schemas/resume.js";
import { coverLetterText } from "../schemas/resume.js";
import { numbersIn } from "../tailoring/validator.js";

export interface ConsistencyFinding {
  severity: "high" | "medium" | "low";
  location: string;
  detail: string;
}

export interface ConsistencyInput {
  job: Job;
  profile: CandidateProfile | null;
  /** All facts, including superseded ones, to detect stale citations. */
  facts: readonly VerifiedFact[];
  resume: { resume: TailoredResume; status: string } | null;
  coverLetter: { letter: CoverLetter; status: string } | null;
  coverLetterSkipped: boolean;
  answers: readonly ApplicationAnswer[];
}

/**
 * Deterministic consistency review across résumé, cover letter, and answers (spec §32 Phase 6; skill
 * application-review). Findings are advisory for the owner; high-severity ones block readiness.
 */
export function checkConsistency(i: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = [];
  const byId = new Map(i.facts.map((f) => [f.id, f]));
  const stale = (ids: readonly string[]) =>
    ids.filter((id) => !byId.has(id) || byId.get(id)?.supersededBy);

  if (!i.resume)
    out.push({
      severity: "high",
      location: "résumé",
      detail: "Select an approved tailored résumé for this job.",
    });
  else {
    if (i.resume.resume.jobId !== i.job.id)
      out.push({
        severity: "high",
        location: "résumé",
        detail: "The selected résumé was tailored for a different job.",
      });
    if (i.resume.status !== "approved")
      out.push({
        severity: "high",
        location: "résumé",
        detail: "The selected résumé is not approved.",
      });
    const s = stale(
      i.resume.resume.experience.flatMap((e) => e.bullets.flatMap((b) => b.sourceFactIds)),
    );
    if (s.length)
      out.push({
        severity: "medium",
        location: "résumé",
        detail: `${s.length} fact(s) used in the résumé were corrected or removed since it was tailored. Consider tailoring a new version.`,
      });
  }

  if (i.coverLetter) {
    const text = coverLetterText(i.coverLetter.letter);
    if (i.coverLetter.letter.jobId !== i.job.id)
      out.push({
        severity: "high",
        location: "cover letter",
        detail: "The cover letter was written for a different job.",
      });
    if (!text.toLowerCase().includes(i.job.company.toLowerCase()))
      out.push({
        severity: "high",
        location: "cover letter",
        detail: `The cover letter does not name ${i.job.company}.`,
      });
    if (i.coverLetter.status !== "approved")
      out.push({
        severity: "high",
        location: "cover letter",
        detail: "The cover letter is not approved.",
      });
    const s = stale(i.coverLetter.letter.paragraphs.flat().flatMap((p) => p.factIds));
    if (s.length)
      out.push({
        severity: "medium",
        location: "cover letter",
        detail: `${s.length} cited fact(s) were corrected or removed since it was written.`,
      });
  } else if (!i.coverLetterSkipped) {
    out.push({
      severity: "high",
      location: "cover letter",
      detail: "Approve a cover letter or choose to apply without one.",
    });
  }

  const seen = new Map<string, ApplicationAnswer>();
  for (const a of i.answers) {
    const where = `question "${a.field.label}"`;
    if (a.provenance.kind === "facts" || a.provenance.kind === "draft") {
      const ids = a.provenance.kind === "facts" ? a.provenance.factIds : a.provenance.factIds;
      const s = stale(ids);
      if (s.length && a.finalValue !== null && a.finalValueSetBy !== "user")
        out.push({
          severity: "medium",
          location: where,
          detail: "Based on a fact that was corrected or removed.",
        });
    }
    const prev = seen.get(a.field.normalizedQuestion);
    if (
      prev &&
      prev.finalValue !== null &&
      a.finalValue !== null &&
      prev.finalValue !== a.finalValue
    ) {
      out.push({
        severity: "high",
        location: where,
        detail: `Answered differently from another question with the same wording ("${prev.field.label}").`,
      });
    }
    seen.set(a.field.normalizedQuestion, a);
    if (
      a.finalValue &&
      (a.field.category === "email" || a.field.category === "phone") &&
      a.finalValueSetBy === "user"
    ) {
      const profileValue =
        a.field.category === "email" ? i.profile?.email?.value : i.profile?.phone?.value;
      if (profileValue && profileValue !== a.finalValue)
        out.push({
          severity: "low",
          location: where,
          detail: "Differs from the value in your profile.",
        });
    }
    if (a.finalValue && a.provenance.kind === "draft" && a.finalValueSetBy === "user") {
      const allowed = new Set([
        ...a.provenance.factIds.flatMap((id) => [...numbersIn(byId.get(id)?.claim ?? "")]),
        ...numbersIn(i.job.descriptionText),
      ]);
      const extra = [...numbersIn(a.finalValue)].filter((n) => !allowed.has(n));
      if (extra.length)
        out.push({
          severity: "medium",
          location: where,
          detail: `Your edited answer contains numbers not in your facts (${extra.join(", ")}). Make sure they are accurate.`,
        });
    }
  }
  return out;
}
