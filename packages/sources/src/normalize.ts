import {
  canonicalJobId,
  seniorityFromTitle as domainSeniority,
  type Compensation,
  type Job,
  type JobSourceType,
} from "@career-agent/domain";
import { canonicalJson, sha256Hex } from "@career-agent/security";
import { extractQualifications } from "./html.js";

type Seniority = Job["seniority"];
type WorkMode = Job["workMode"];
type EmploymentType = Job["employmentType"];

/** Seniority from explicit title words only (shared with matching). */
export const seniorityFromTitle = (title: string): Seniority => domainSeniority(title);

export function workModeFrom(...hints: (string | boolean | null | undefined)[]): WorkMode {
  for (const h of hints) {
    if (h === true) return "remote";
    if (typeof h !== "string") continue;
    const v = h.toLowerCase().replace(/[^a-z]/g, "");
    if (v === "remote" || v === "telecommute" || v.includes("fullyremote")) return "remote";
    if (v === "hybrid") return "hybrid";
    if (v === "onsite" || v === "inoffice") return "onsite";
  }
  return "unknown";
}

/** Work mode from a location label such as "Remote - EU" or "Berlin (Hybrid)". */
export function workModeFromLocation(location: string | null | undefined): WorkMode {
  if (!location) return "unknown";
  if (/\bremote\b/i.test(location)) return "remote";
  if (/\bhybrid\b/i.test(location)) return "hybrid";
  return "unknown";
}

export function employmentTypeFrom(value: string | null | undefined): EmploymentType {
  const v = (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (v.includes("fulltime") || v === "permanent") return "full_time";
  if (v.includes("parttime")) return "part_time";
  if (v.includes("intern")) return "internship";
  if (v.includes("contract") || v.includes("freelance")) return "contract";
  if (v.includes("temp")) return "temporary";
  return "unknown";
}

const PERIODS: [RegExp, Compensation["period"]][] = [
  [/year|annual|annum|yr/i, "year"],
  [/month/i, "month"],
  [/week/i, "week"],
  [/day|daily/i, "day"],
  [/hour|hourly/i, "hour"],
];

export function compensationFrom(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string | null | undefined,
  interval: string | null | undefined,
): Compensation | null {
  const cur = (currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  const period = PERIODS.find(([re]) => re.test(interval ?? ""))?.[1];
  if (!period) return null;
  const lo = typeof min === "number" && Number.isFinite(min) && min >= 0 ? min : null;
  const hi = typeof max === "number" && Number.isFinite(max) && max >= 0 ? max : null;
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null && lo > hi) return null;
  return { min: lo, max: hi, currency: cur, period };
}

const NOT_OFFERED =
  /\b(not|unable to|cannot|can['’]?t|do(es)? not|won['’]?t|will not)\s+(provide|offer|sponsor|support)[^.]{0,40}\b(visa|sponsorship|work permit)/i;
const NOT_OFFERED_2 = /\b(no|without)\s+(visa\s+)?sponsorship\b/i;
const OFFERED =
  /\b(visa\s+sponsorship\s+(is\s+)?(available|provided|offered|possible)|we\s+(can\s+|will\s+)?sponsor|sponsorship\s+available|relocation\s+and\s+visa\s+support)\b/i;

/** Sponsorship signal with the sentence it came from. Ambiguity stays "unknown". */
export function sponsorshipSignal(text: string): Job["sponsorship"] {
  const sentences = text.split(/(?<=[.!?])\s+|\n/);
  for (const s of sentences) {
    if (NOT_OFFERED.test(s) || NOT_OFFERED_2.test(s))
      return { value: "not_offered", confidence: 0.8, evidence: s.trim().slice(0, 500) };
  }
  for (const s of sentences) {
    if (OFFERED.test(s))
      return { value: "offered", confidence: 0.7, evidence: s.trim().slice(0, 500) };
  }
  return { value: "unknown", confidence: 0, evidence: null };
}

export function rawHash(raw: unknown): string {
  return sha256Hex(canonicalJson(raw));
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Hash of the fields that matter to the user; used for change detection and cross-source duplicate detection. */
export function contentHash(
  j: Pick<Job, "title" | "company" | "locations" | "descriptionText" | "compensation">,
): string {
  return sha256Hex(
    canonicalJson({
      title: norm(j.title),
      company: norm(j.company),
      locations: j.locations.map(norm).sort(),
      description: norm(j.descriptionText),
      compensation: j.compensation,
    }),
  );
}

export interface DraftJob {
  source: JobSourceType;
  externalId: string;
  sourceUrl: string;
  applyUrl: string | null;
  company: string;
  title: string;
  team: string | null;
  locations: string[];
  workMode: WorkMode;
  employmentType: EmploymentType;
  descriptionText: string;
  descriptionHtmlSanitized: string | null;
  /** Explicit qualification lists when the source provides them; otherwise parsed from the description. */
  qualifications?: { required: string[]; preferred: string[] };
  compensation: Compensation | null;
  postedAt: string | null;
  updatedAt: string | null;
  raw: unknown;
}

const isoOrNull = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Builds the canonical Job (status NORMALIZED). Unknown values stay unknown. */
export function toJob(d: DraftJob, fetchedAt: Date): Job {
  const quals = d.qualifications ?? extractQualifications(d.descriptionText);
  const base = {
    title: d.title.trim(),
    company: d.company.trim(),
    locations: [...new Set(d.locations.map((l) => l.trim()).filter(Boolean))],
    descriptionText: d.descriptionText,
    compensation: d.compensation,
  };
  const seen = fetchedAt.toISOString();
  return {
    id: canonicalJobId(d.source, d.externalId),
    source: d.source,
    externalId: d.externalId,
    sourceUrl: d.sourceUrl,
    applyUrl: d.applyUrl,
    ...base,
    team: d.team?.trim() || null,
    workMode:
      d.workMode === "unknown" ? workModeFromLocation(base.locations.join(" ")) : d.workMode,
    employmentType: d.employmentType,
    seniority: seniorityFromTitle(base.title),
    descriptionHtmlSanitized: d.descriptionHtmlSanitized,
    requiredQualifications: quals.required,
    preferredQualifications: quals.preferred,
    sponsorship: sponsorshipSignal(d.descriptionText),
    postedAt: isoOrNull(d.postedAt),
    updatedAt: isoOrNull(d.updatedAt),
    firstSeenAt: seen,
    lastSeenAt: seen,
    sourceHash: rawHash(d.raw),
    contentHash: contentHash(base),
    status: "NORMALIZED",
    filterReasons: [],
    removedFromSourceAt: null,
  };
}
