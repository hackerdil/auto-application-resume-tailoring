import { z } from "zod";
import { CanonicalJobId } from "./job.js";
import { Id, IsoDateTime, Sensitivity } from "./common.js";

export const ApplicationState = z.enum([
  "DRAFT",
  "TAILORING",
  "VERIFYING",
  "READY_TO_PREPARE",
  "PREPARING",
  "AWAITING_USER_INPUT",
  "READY_FOR_REVIEW",
  "APPROVED_TO_SUBMIT",
  "SUBMITTING",
  "SUBMITTED",
  "SUBMISSION_UNCERTAIN",
  "FAILED",
  "WITHDRAWN",
]);
export type ApplicationState = z.infer<typeof ApplicationState>;

export const Application = z.object({
  id: Id,
  userId: Id,
  jobId: CanonicalJobId,
  state: ApplicationState,
  resumeVersionId: Id.nullable().default(null),
  coverLetterVersionId: Id.nullable().default(null),
  coverLetterSkipped: z.boolean().default(false),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Application = z.infer<typeof Application>;

export const FieldType = z.enum([
  "text",
  "textarea",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "select",
  "radio",
  "checkbox",
  "file",
  "unknown",
]);
export type FieldType = z.infer<typeof FieldType>;

export const AnswerDecision = z.enum(["auto_fill", "needs_review", "requires_user", "prohibited"]);
export type AnswerDecision = z.infer<typeof AnswerDecision>;

export const QuestionCategory = z.enum([
  "identity_name",
  "email",
  "phone",
  "location",
  "profile_link",
  "resume_file",
  "cover_letter_file",
  "cover_letter_text",
  "employment_current",
  "education",
  "motivation",
  "experience_story",
  "additional_info",
  "referral_source",
  "referral",
  "work_authorization",
  "sponsorship",
  "compensation",
  "availability",
  "relocation",
  "travel",
  "legal_attestation",
  "consent_terms",
  "conflict_of_interest",
  "non_compete",
  "criminal_background",
  "demographic",
  "date_of_birth",
  "government_id",
  "signature",
  "captcha",
  "unknown",
]);
export type QuestionCategory = z.infer<typeof QuestionCategory>;

export const AnswerProvenance = z.union([
  z.object({ kind: z.literal("facts"), factIds: z.array(Id).min(1) }),
  z.object({ kind: z.literal("saved_answer"), savedAnswerId: Id }),
  z.object({
    kind: z.literal("profile"),
    field: z.enum(["fullName", "firstName", "lastName", "email", "phone", "location", "link"]),
  }),
  z.object({ kind: z.literal("owner_default"), note: z.string() }),
  z.object({ kind: z.literal("artifact"), artifactId: Id, label: z.string() }),
  z.object({ kind: z.literal("draft"), note: z.string(), factIds: z.array(Id).default([]) }),
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("none") }),
]);
export type AnswerProvenance = z.infer<typeof AnswerProvenance>;

export const ApplicationField = z.object({
  id: z.string().min(1),
  label: z.string(),
  normalizedQuestion: z.string(),
  type: FieldType,
  required: z.boolean(),
  options: z.array(z.string()),
  category: QuestionCategory.default("unknown"),
  origin: z.enum(["manual", "common", "page"]).default("manual"),
});
export type ApplicationField = z.infer<typeof ApplicationField>;

/**
 * Spec §11 application answer. `needs_review` and `requires_user` answers count only once the owner sets the
 * final value; `auto_fill` answers are finalized by the system from explicit owner data.
 */
export const ApplicationAnswer = z
  .object({
    field: ApplicationField,
    proposedValue: z.string().nullable(),
    provenance: AnswerProvenance,
    confidence: z.number().min(0).max(1),
    sensitivity: Sensitivity,
    decision: AnswerDecision,
    reviewerChanges: z.array(z.string()),
    finalValue: z.string().nullable(),
    finalValueSetBy: z.enum(["user", "system"]).nullable(),
    /** Why the planner decided as it did; shown to the owner. */
    notes: z.array(z.string()).default([]),
  })
  .refine((a) => a.decision !== "prohibited" || a.finalValue === null, {
    message: "prohibited fields must never carry a value",
  })
  .refine(
    (a) => a.decision !== "requires_user" || a.finalValue === null || a.finalValueSetBy === "user",
    {
      message: "requires_user fields can only be finalized by the user",
    },
  )
  .refine(
    (a) => a.decision !== "needs_review" || a.finalValue === null || a.finalValueSetBy === "user",
    {
      message: "needs_review fields can only be finalized by the user",
    },
  )
  .refine(
    (a) =>
      a.finalValue === null ||
      a.field.options.length === 0 ||
      a.field.type === "checkbox" ||
      a.field.options.includes(a.finalValue),
    {
      message: "a choice field's value must be one of its options",
    },
  );
export type ApplicationAnswer = z.infer<typeof ApplicationAnswer>;
export type ApplicationAnswerInput = z.input<typeof ApplicationAnswer>;

/**
 * An answer set is complete when every required field has a final value (set by the owner unless it was filled
 * from explicit owner data), and no prohibited field has a value. Optional questions may stay blank; they are
 * left empty in the form.
 */
export function isAnswerSetComplete(answers: readonly ApplicationAnswer[]): boolean {
  return answers.every((a) => {
    if (a.decision === "prohibited") return a.finalValue === null;
    if (!a.field.required)
      return a.finalValue === null || a.decision === "auto_fill" || a.finalValueSetBy === "user";
    if (a.decision === "auto_fill") return a.finalValue !== null;
    return a.finalValue !== null && a.finalValueSetBy === "user";
  });
}
