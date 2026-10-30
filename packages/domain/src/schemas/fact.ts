import { z } from "zod";
import { Id, IsoDateTime, NonEmpty } from "./common.js";

export const FactCategory = z.enum([
  "identity",
  "contact",
  "employment",
  "role",
  "achievement",
  "project",
  "education",
  "skill",
  "certification",
  "language",
  "work_authorization",
  "availability",
  "link",
  "other",
]);
export type FactCategory = z.infer<typeof FactCategory>;

export const FactTransformation = z.enum(["select", "reorder", "shorten", "rephrase", "combine"]);
export type FactTransformation = z.infer<typeof FactTransformation>;

export const FactSource = z.enum(["resume", "user-confirmed", "imported-document"]);

/** Spec §11. Facts are append-only; corrections create a new fact and set `supersededBy` on the old one. */
export const VerifiedFact = z.object({
  id: Id,
  category: FactCategory,
  claim: NonEmpty.max(2000),
  source: FactSource,
  sourceArtifactId: Id.optional(),
  sourceLocation: z.string().max(500).optional(),
  evidenceText: z.string().max(4000).optional(),
  verifiedAt: IsoDateTime,
  supersededBy: Id.optional(),
  allowedTransformations: z.array(FactTransformation).min(1),
  sensitive: z.boolean(),
});
export type VerifiedFact = z.infer<typeof VerifiedFact>;

export const NewVerifiedFact = VerifiedFact.omit({ id: true, supersededBy: true });
export type NewVerifiedFact = z.infer<typeof NewVerifiedFact>;
