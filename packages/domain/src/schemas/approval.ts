import { z } from "zod";
import { Id, IsoDateTime } from "./common.js";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Identity of the one control the submission service may click (docs/APPROVAL_MODEL.md §2). */
export const SubmitControlIdentity = z.object({
  adapter: z.string().min(1),
  selectorFingerprint: z.string().min(1),
  accessibleName: z.string(),
  frameUrl: z.string(),
});
export type SubmitControlIdentity = z.infer<typeof SubmitControlIdentity>;

/** What an approval is bound to. Every field except the times is recomputed from live state before the click. */
export const ApprovalBinding = z.object({
  applicationId: Id,
  ownerId: Id,
  jobUrl: z.string().min(1),
  origin: z.string().min(1),
  jobId: z.string().min(1),
  formSnapshotHash: Sha256,
  answerSetHash: Sha256,
  resumeArtifactHash: Sha256,
  coverLetterArtifactHash: Sha256.nullable(),
  submitControl: SubmitControlIdentity,
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ApprovalBinding = z.infer<typeof ApprovalBinding>;

/** The binding without its times: what live state must reproduce exactly. */
export type BindingMaterial = Omit<ApprovalBinding, "issuedAt" | "expiresAt">;

export const bindingMaterial = (b: ApprovalBinding): BindingMaterial => {
  const { issuedAt: _i, expiresAt: _e, ...rest } = b;
  return rest;
};

/** Which binding fields differ (names only; never values). */
export function bindingDifferences(a: BindingMaterial, b: BindingMaterial): string[] {
  const keys = Object.keys(a) as (keyof BindingMaterial)[];
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export type SubmissionOutcome = "submitted" | "uncertain" | "rejected_before_send" | "failed";

/** Redacted evidence of what the page showed after the click; never form values. */
export interface SubmissionEvidence {
  url: string | null;
  title: string;
  headings: string[];
  errors: string[];
  writesSent: number;
  note: string;
}
