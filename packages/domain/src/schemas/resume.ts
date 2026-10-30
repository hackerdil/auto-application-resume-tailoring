import { z } from "zod";
import { Id, NonEmpty } from "./common.js";
import { FactTransformation } from "./fact.js";

export const VerifierFinding = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  kind: z.enum([
    "unsupported_number",
    "unsupported_entity",
    "unsupported_tool",
    "unsupported_title",
    "unsupported_date",
    "unsupported_scope",
    "unsupported_causal_claim",
    "missing_provenance",
    "chronology_mismatch",
    "other",
  ]),
  detail: z.string().max(1000),
});
export type VerifierFinding = z.infer<typeof VerifierFinding>;

export const TailoredBullet = z.object({
  id: Id,
  text: NonEmpty.max(600),
  sourceFactIds: z.array(Id).min(1, "every bullet must cite at least one fact"),
  targetRequirementKeys: z.array(z.string()),
  transformation: FactTransformation,
  verifier: z.object({
    deterministic: z.enum(["pass", "fail", "pending"]),
    review: z.enum(["pass", "fail", "unavailable", "pending"]),
    findings: z.array(VerifierFinding),
  }),
});
export type TailoredBullet = z.infer<typeof TailoredBullet>;

export const ResumeLength = z.enum(["one-page", "full"]);
export type ResumeLength = z.infer<typeof ResumeLength>;

/** One employer/role block. The heading is the role fact's claim, verbatim, so titles and dates never drift. */
export const ResumeEntry = z.object({
  roleFactId: Id.nullable(),
  heading: NonEmpty.max(600),
  bullets: z.array(TailoredBullet),
});
export type ResumeEntry = z.infer<typeof ResumeEntry>;

/** Skills, education, and similar sections are verbatim fact claims. */
export const ResumeListItem = z.object({ text: NonEmpty.max(1000), factId: Id });
export type ResumeListItem = z.infer<typeof ResumeListItem>;

export const DroppedClaim = z.object({
  text: z.string().max(600),
  sourceFactIds: z.array(z.string()),
  reason: z.string().max(1000),
});

/** Spec §11 tailored résumé: structured content stored separately from rendered artifacts. */
export const TailoredResume = z.object({
  id: Id,
  jobId: z.string().nullable(),
  profileVersion: z.number().int().nonnegative(),
  length: ResumeLength,
  createdAt: z.iso.datetime(),
  header: z.object({
    name: z.string().max(200),
    contact: z.array(z.string().max(300)),
    links: z.array(z.object({ label: z.string(), url: z.httpUrl() })),
  }),
  summary: z
    .object({
      text: NonEmpty.max(800),
      sourceFactIds: z.array(Id).min(1),
      verifier: TailoredBullet.shape.verifier,
    })
    .nullable(),
  experience: z.array(ResumeEntry),
  skills: z.array(ResumeListItem),
  education: z.array(ResumeListItem),
  certifications: z.array(ResumeListItem),
  projects: z.array(ResumeListItem),
  languages: z.array(ResumeListItem),
  /** Generated claims removed because they failed verification twice. */
  dropped: z.array(DroppedClaim),
  /** Verified facts left out for length or relevance (not failures). */
  omittedFactIds: z.array(Id),
  meta: z.object({
    mode: z.enum(["deterministic", "model-assisted"]),
    generator: z.string().nullable(),
    reviewer: z.string().nullable(),
    review: z.enum(["pass", "fail", "unavailable"]),
    regenerated: z.number().int().nonnegative(),
    promptIds: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

/** A cover-letter sentence. "fact" cites verified facts; "motivation" may only draw on the posting; "courtesy" is fixed template text. */
export const LetterSegment = z.object({
  kind: z.enum(["fact", "motivation", "courtesy"]),
  text: NonEmpty.max(600),
  factIds: z.array(Id),
  transformation: FactTransformation.nullable(),
});
export type LetterSegment = z.infer<typeof LetterSegment>;

export const CoverLetter = z.object({
  id: Id,
  applicationId: Id,
  jobId: z.string(),
  createdAt: z.iso.datetime(),
  greeting: NonEmpty.max(200),
  paragraphs: z.array(z.array(LetterSegment)).min(1),
  closing: NonEmpty.max(200),
  signature: z.string().max(200),
  dropped: z.array(DroppedClaim),
  meta: z.object({
    mode: z.enum(["deterministic", "model-assisted"]),
    generator: z.string().nullable(),
    reviewer: z.string().nullable(),
    review: z.enum(["pass", "fail", "unavailable"]),
    regenerated: z.number().int().nonnegative(),
    promptIds: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});
export type CoverLetter = z.infer<typeof CoverLetter>;

export function coverLetterText(l: CoverLetter): string {
  return [
    l.greeting,
    ...l.paragraphs.map((p) => p.map((s) => s.text).join(" ")),
    l.closing,
    l.signature,
  ]
    .filter((x) => x.trim())
    .join("\n\n");
}
