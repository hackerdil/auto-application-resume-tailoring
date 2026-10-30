import { z } from "zod";
import { Compensation, HttpUrl, Id, IsoDateTime, NonEmpty, Sensitivity } from "./common.js";

export const Disclosure = z.enum(["always", "ask", "never"]);

const Disclosable = <T extends z.ZodType>(value: T) =>
  z.object({ value, disclosure: Disclosure.default("ask") });

export const WorkMode = z.enum(["remote", "hybrid", "onsite"]);
export type WorkMode = z.infer<typeof WorkMode>;

export const LanguageLevel = z.enum([
  "basic",
  "conversational",
  "professional",
  "fluent",
  "native",
]);

export const Preferences = z.object({
  targetRoles: z.array(NonEmpty).default([]),
  excludedRoles: z.array(NonEmpty).default([]),
  excludedCompanies: z.array(NonEmpty).default([]),
  locations: z.array(NonEmpty).default([]),
  workModes: z.array(WorkMode).default([]),
  willingToRelocate: z.boolean().nullable().default(null),
  compensation: Compensation.nullable().default(null),
});
export type Preferences = z.infer<typeof Preferences>;

/**
 * Demographic defaults are stored only if the owner explicitly chooses to save them.
 * "prefer_not_to_answer" is used only when it is set here AND the site offers that exact option (spec §4.3).
 */
export const DemographicDefaults = z.object({
  useDeclineWhenOffered: z.boolean().default(false),
  answers: z.record(z.string(), z.string()).default({}),
});

/** Spec §11 candidate profile. Employment/education/skills live in the fact bank and are referenced by ID. */
export const CandidateProfile = z.object({
  id: Id,
  userId: Id,
  version: z.number().int().positive(),
  fullName: Disclosable(NonEmpty),
  email: Disclosable(z.email()).optional(),
  phone: Disclosable(z.string().max(40)).optional(),
  location: Disclosable(z.string().max(200)).optional(),
  links: z.array(z.object({ label: NonEmpty, url: HttpUrl })).default([]),
  preferences: Preferences,
  workAuthorizationFactIds: z.array(Id).default([]),
  noticePeriod: z.string().max(200).nullable().default(null),
  availableFrom: z.iso.date().nullable().default(null),
  languages: z.array(z.object({ language: NonEmpty, level: LanguageLevel })).default([]),
  demographicDefaults: DemographicDefaults.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

/** An explicit answer the owner saved for a recurring question. */
export const SavedAnswer = z.object({
  id: Id,
  userId: Id,
  normalizedQuestion: NonEmpty.max(500),
  value: z.string().max(10_000),
  sensitivity: Sensitivity,
  createdAt: IsoDateTime,
  revokedAt: IsoDateTime.optional(),
});
export type SavedAnswer = z.infer<typeof SavedAnswer>;

/** Editable part of the profile; id, version and timestamps are managed by the repository. */
export const ProfileDraft = CandidateProfile.omit({
  id: true,
  userId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
});
export type ProfileDraft = z.infer<typeof ProfileDraft>;
export type ProfileDraftInput = z.input<typeof ProfileDraft>;
