import { z } from "zod";
import { Id, IsoDateTime, NonEmpty } from "./common.js";
import { FactCategory } from "./fact.js";

export const CandidateStatus = z.enum(["pending", "confirmed", "rejected"]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

/** A suggested fact extracted from an imported document. It becomes a VerifiedFact only when the owner confirms it. */
export const FactCandidate = z.object({
  id: Id,
  userId: Id,
  artifactId: Id,
  category: FactCategory,
  claim: NonEmpty.max(1000),
  evidenceText: NonEmpty.max(2000),
  sourceLocation: z.string().nullable(),
  extractor: z.enum(["deterministic", "model"]),
  sensitive: z.boolean(),
  status: CandidateStatus,
  factId: Id.nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type FactCandidate = z.infer<typeof FactCandidate>;

export type NewFactCandidate = Omit<
  FactCandidate,
  "id" | "userId" | "artifactId" | "status" | "factId" | "createdAt" | "decidedAt"
>;
