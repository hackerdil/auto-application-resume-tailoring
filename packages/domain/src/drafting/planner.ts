import { coverage, tokenSet } from "../matching/text.js";
import type { ApplicationAnswer, ApplicationField } from "../schemas/application.js";
import { ApplicationAnswer as AnswerSchema } from "../schemas/application.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { CandidateProfile, SavedAnswer } from "../schemas/profile.js";
import { normalizeQuestion } from "../services/profile.js";
import { groupByRole } from "../tailoring/selection.js";
import { classifyQuestion } from "./classifier.js";

export interface PlannerContext {
  profile: CandidateProfile | null;
  savedAnswers: readonly SavedAnswer[];
  /** Active, non-sensitive facts. */
  facts: readonly VerifiedFact[];
  approvedResume: { pdfArtifactId: string } | null;
  approvedCoverLetter: { pdfArtifactId: string; text: string } | null;
  /** Verified drafts for draftable questions, keyed by field id. */
  drafts: ReadonlyMap<string, { text: string; factIds: string[] }>;
}

const DECLINE =
  /\b(decline|prefer not|don['’]?t wish|do not wish|choose not|not to (answer|say|disclose))\b/i;

function similar(a: string, b: string): boolean {
  const x = tokenSet(a);
  const y = tokenSet(b);
  return x.size > 0 && y.size > 0 && coverage(x, y) >= 0.75 && coverage(y, x) >= 0.75;
}

/** Maps a value onto a choice field's exact option (case-insensitive), or null when it is not one of them. */
function toOption(value: string, field: ApplicationField): string | null {
  if (field.options.length === 0 || field.type === "checkbox") return value;
  return field.options.find((o) => o.trim().toLowerCase() === value.trim().toLowerCase()) ?? null;
}

type Partial = Pick<
  ApplicationAnswer,
  "proposedValue" | "provenance" | "decision" | "confidence"
> & { notes: string[] };

/**
 * Plans one answer per field (spec §16). Only explicit owner data fills anything automatically: profile fields
 * the owner chose to share, links, approved artifacts, and saved answers to non-sensitive questions. Sensitive or
 * protected questions are proposed only from the owner's own saved answers or defaults, and always for review.
 * Prohibited fields never get a value.
 */
export function planAnswer(field: ApplicationField, ctx: PlannerContext): ApplicationAnswer {
  const c = classifyQuestion(field.label, field.type);
  const notes: string[] = c.reason ? [c.reason] : [];
  const sensitive = c.sensitivity === "sensitive" || c.sensitivity === "protected";
  let p: Partial = {
    proposedValue: null,
    provenance: { kind: "none" },
    decision: c.decision,
    confidence: 1,
    notes,
  };

  if (c.decision !== "prohibited") {
    const q = normalizeQuestion(field.label);
    const exact = ctx.savedAnswers.find((s) => s.normalizedQuestion === q);
    const near = exact ? undefined : ctx.savedAnswers.find((s) => similar(s.normalizedQuestion, q));
    if (exact) {
      const v = toOption(exact.value, field);
      if (v === null)
        notes.push(`Your saved answer "${exact.value}" is not one of this question's options.`);
      else
        p = {
          proposedValue: v,
          provenance: { kind: "saved_answer", savedAnswerId: exact.id },
          decision: sensitive || c.decision === "requires_user" ? "needs_review" : "auto_fill",
          confidence: 1,
          notes: [...notes, "From your saved answer."],
        };
    } else if (near) {
      const v = toOption(near.value, field);
      if (v !== null) {
        // A similar question is only a suggestion: the owner still answers.
        p = {
          ...p,
          proposedValue: v,
          provenance: { kind: "saved_answer", savedAnswerId: near.id },
          confidence: 0.6,
          notes: [
            ...notes,
            `Suggested from your saved answer to a similar question ("${near.normalizedQuestion}").`,
          ],
        };
        if (p.decision === "auto_fill") p.decision = "needs_review";
      }
    }
    if (p.provenance.kind === "none") p = { ...p, ...fromOwnerData(field, c.category, ctx, notes) };
  }

  if (p.proposedValue !== null && toOption(p.proposedValue, field) === null) {
    p = {
      ...p,
      proposedValue: null,
      provenance: { kind: "none" },
      decision: c.decision === "prohibited" ? "prohibited" : "requires_user",
      notes: [...p.notes, "No matching option."],
    };
  }
  // Nothing explicit to fill with: required → the owner answers; optional → left blank (and listed as such).
  if (p.decision === "auto_fill" && p.proposedValue === null) {
    if (field.required) p.decision = "requires_user";
    else
      p.notes = [
        ...p.notes,
        "Nothing in your profile or approved files fills this; it will be left blank unless you answer it.",
      ];
  }
  const finalValue = p.decision === "auto_fill" ? p.proposedValue : null;
  return AnswerSchema.parse({
    field: { ...field, category: c.category },
    proposedValue: p.proposedValue,
    provenance: p.provenance,
    confidence: p.confidence,
    sensitivity: c.sensitivity,
    decision: p.decision,
    reviewerChanges: [],
    finalValue,
    finalValueSetBy: finalValue === null ? null : "system",
    notes: p.notes,
  });
}

function fromOwnerData(
  field: ApplicationField,
  category: ApplicationField["category"],
  ctx: PlannerContext,
  notes: string[],
): Partial | Record<string, never> {
  const prof = ctx.profile;
  const disclosed = (
    v: { value: string; disclosure: string } | undefined,
    which: "fullName" | "email" | "phone" | "location",
    transform: (s: string) => string = (s) => s,
  ): Partial | Record<string, never> => {
    if (!v || v.disclosure === "never")
      return {
        notes: [...notes, "Not shared: your profile has no value or it is set to never share."],
        decision: "requires_user",
        proposedValue: null,
        provenance: { kind: "none" },
        confidence: 1,
      };
    const value = transform(v.value);
    return {
      proposedValue: value,
      provenance: { kind: "profile", field: which },
      decision: v.disclosure === "always" ? "auto_fill" : "needs_review",
      confidence: 1,
      notes:
        v.disclosure === "always"
          ? notes
          : [...notes, "Your profile says to ask before sharing this."],
    };
  };
  switch (category) {
    case "identity_name": {
      const label = field.label.toLowerCase();
      const [first = "", ...rest] = (prof?.fullName.value ?? "").trim().split(/\s+/);
      if (/\b(first|given)\b/.test(label))
        return disclosed(prof?.fullName, "fullName", () => first);
      if (/\b(last|family|surname)\b/.test(label))
        return rest.length
          ? disclosed(prof?.fullName, "fullName", () => rest.join(" "))
          : {
              decision: "requires_user",
              proposedValue: null,
              provenance: { kind: "none" },
              confidence: 1,
              notes,
            };
      return disclosed(prof?.fullName, "fullName");
    }
    case "email":
      return disclosed(prof?.email, "email");
    case "phone":
      return disclosed(prof?.phone, "phone");
    case "location":
      return field.options.length ? {} : disclosed(prof?.location, "location");
    case "profile_link": {
      const want = /linkedin/i.test(field.label)
        ? /linkedin/i
        : /github|gitlab/i.test(field.label)
          ? /github|gitlab/i
          : /portfolio|website|site|blog/i;
      const link =
        prof?.links.find((l) => want.test(l.label) || want.test(l.url)) ??
        (want.source.includes("portfolio") ? prof?.links[0] : undefined);
      return link
        ? {
            proposedValue: link.url,
            provenance: { kind: "profile", field: "link" },
            decision: "auto_fill",
            confidence: 0.9,
            notes,
          }
        : {};
    }
    case "resume_file":
      return ctx.approvedResume
        ? {
            proposedValue: "approved-resume.pdf",
            provenance: {
              kind: "artifact",
              artifactId: ctx.approvedResume.pdfArtifactId,
              label: "Approved tailored résumé (PDF)",
            },
            decision: "auto_fill",
            confidence: 1,
            notes,
          }
        : {
            proposedValue: null,
            provenance: { kind: "none" },
            decision: "requires_user",
            confidence: 1,
            notes: [...notes, "Approve a tailored résumé for this job first."],
          };
    case "cover_letter_file":
      return ctx.approvedCoverLetter
        ? {
            proposedValue: "approved-cover-letter.pdf",
            provenance: {
              kind: "artifact",
              artifactId: ctx.approvedCoverLetter.pdfArtifactId,
              label: "Approved cover letter (PDF)",
            },
            decision: "auto_fill",
            confidence: 1,
            notes,
          }
        : {
            proposedValue: null,
            provenance: { kind: "none" },
            decision: field.required ? "requires_user" : "needs_review",
            confidence: 1,
            notes: [...notes, "Approve a cover letter first, or leave this optional upload empty."],
          };
    case "cover_letter_text":
      return ctx.approvedCoverLetter
        ? {
            proposedValue: ctx.approvedCoverLetter.text,
            provenance: {
              kind: "artifact",
              artifactId: ctx.approvedCoverLetter.pdfArtifactId,
              label: "Approved cover letter (text)",
            },
            decision: "needs_review",
            confidence: 1,
            notes,
          }
        : {
            proposedValue: null,
            provenance: { kind: "none" },
            decision: "requires_user",
            confidence: 1,
            notes: [...notes, "Approve a cover letter first."],
          };
    case "employment_current": {
      const role = groupByRole(ctx.facts).find((g) => g.role)?.role;
      return role && field.options.length === 0
        ? {
            proposedValue: role.claim,
            provenance: { kind: "facts", factIds: [role.id] },
            decision: "needs_review",
            confidence: 0.8,
            notes: [...notes, "Your most recent role fact, verbatim."],
          }
        : {};
    }
    case "education": {
      const edu = ctx.facts.filter((f) => f.category === "education");
      return edu.length && field.options.length === 0
        ? {
            proposedValue: edu.map((f) => f.claim).join("; "),
            provenance: { kind: "facts", factIds: edu.map((f) => f.id) },
            decision: "needs_review",
            confidence: 0.8,
            notes: [...notes, "Your education facts, verbatim."],
          }
        : {};
    }
    case "motivation":
    case "experience_story":
    case "additional_info": {
      const d = ctx.drafts.get(field.id);
      return d
        ? {
            proposedValue: d.text,
            provenance: {
              kind: "draft",
              note: "Drafted and verified against your facts",
              factIds: d.factIds,
            },
            decision: "needs_review",
            confidence: 0.7,
            notes,
          }
        : {
            proposedValue: null,
            provenance: { kind: "none" },
            decision: field.required ? "requires_user" : "needs_review",
            confidence: 1,
            notes: [...notes, "No verified draft is available; write this yourself."],
          };
    }
    case "demographic": {
      const defaults = prof?.demographicDefaults;
      const q = normalizeQuestion(field.label);
      const saved = defaults?.answers[q];
      const savedOption = saved ? toOption(saved, field) : null;
      if (savedOption)
        return {
          proposedValue: savedOption,
          provenance: { kind: "owner_default", note: "Your saved self-identification answer" },
          decision: "needs_review",
          confidence: 1,
          notes,
        };
      const decline = defaults?.useDeclineWhenOffered
        ? field.options.find((o) => DECLINE.test(o))
        : undefined;
      return decline
        ? {
            proposedValue: decline,
            provenance: {
              kind: "owner_default",
              note: 'Your default: "prefer not to answer" when offered',
            },
            decision: "needs_review",
            confidence: 1,
            notes,
          }
        : {};
    }
    default:
      return {};
  }
}

export function planAnswers(
  fields: readonly ApplicationField[],
  ctx: PlannerContext,
): ApplicationAnswer[] {
  return fields.map((f) => planAnswer(f, ctx));
}
