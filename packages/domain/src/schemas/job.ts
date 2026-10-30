import { z } from "zod";
import { Compensation, HttpUrl, IsoDateTime, NonEmpty, Sha256Hex } from "./common.js";

export const JobSourceType = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "manual",
  "generic",
]);
export type JobSourceType = z.infer<typeof JobSourceType>;

export const JobStatus = z.enum([
  "DISCOVERED",
  "NORMALIZED",
  "FILTERED",
  "ELIGIBLE",
  "SCORED",
  "SHORTLISTED",
  "SKIPPED",
  "ARCHIVED",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const CanonicalJobId = z.string().regex(/^[a-z0-9_-]+:.+$/, "expected source:externalId");

export const JobWorkMode = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export const EmploymentType = z.enum([
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
  "unknown",
]);
export const Seniority = z.enum([
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "director",
  "executive",
  "unknown",
]);

export const SponsorshipSignal = z.object({
  value: z.enum(["offered", "not_offered", "unknown"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(1000).nullable(),
});

export const Job = z.object({
  id: CanonicalJobId,
  source: JobSourceType,
  externalId: NonEmpty,
  sourceUrl: HttpUrl,
  applyUrl: HttpUrl.nullable(),
  company: NonEmpty,
  title: NonEmpty,
  team: z.string().nullable(),
  locations: z.array(z.string()),
  workMode: JobWorkMode,
  employmentType: EmploymentType,
  seniority: Seniority,
  descriptionText: z.string(),
  descriptionHtmlSanitized: z.string().nullable(),
  requiredQualifications: z.array(z.string()),
  preferredQualifications: z.array(z.string()),
  compensation: Compensation.nullable(),
  sponsorship: SponsorshipSignal,
  postedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime.nullable(),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  sourceHash: Sha256Hex,
  contentHash: Sha256Hex,
  status: JobStatus,
  filterReasons: z.array(z.string()),
  /** Set when a complete fetch of the job's source no longer lists it (the posting was probably closed). */
  removedFromSourceAt: IsoDateTime.nullable().default(null),
});
export type Job = z.infer<typeof Job>;

export const RequirementKind = z.enum(["required", "preferred", "inferred", "unknown"]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const JobRequirement = z.object({
  jobId: CanonicalJobId,
  key: z.string().regex(/^R\d{1,3}$/, "expected R<n>"),
  text: NonEmpty.max(1000),
  kind: RequirementKind,
  evidence: z.string().max(1000).nullable(),
});
export type JobRequirement = z.infer<typeof JobRequirement>;
