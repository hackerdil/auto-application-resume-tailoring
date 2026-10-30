// Browser client for the local API. Handles the session, CSRF token, and Idempotency-Key headers.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function ensureSession(): Promise<string> {
  if (csrfToken) return csrfToken;
  const r = await fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
  if (!r.ok)
    throw new ApiError(r.status, "SESSION", "Could not start a local session. Is the API running?");
  csrfToken = ((await r.json()) as { csrfToken: string }).csrfToken;
  return csrfToken;
}

/** A fresh key per user action; pass the same key to retry that action safely. */
export const newActionKey = (): string => crypto.randomUUID();

export async function api<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  actionKey: string = newActionKey(),
): Promise<T> {
  const token = await ensureSession();
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (method !== "GET") {
    headers["x-csrf-token"] = token;
    headers["idempotency-key"] = actionKey;
    if (body instanceof FormData) payload = body;
    else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body ?? {});
    }
  }
  const r = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    ...(payload ? { body: payload } : {}),
  });
  if (r.status === 401 || (r.status === 403 && csrfToken)) csrfToken = null;
  const data = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) {
    const err = (data as { error?: { code?: string; message?: string; issues?: string[] } } | null)
      ?.error;
    throw new ApiError(
      r.status,
      err?.code ?? "ERROR",
      err?.message ?? `Request failed (${r.status}).`,
      err?.issues ?? [],
    );
  }
  return data as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError)
    return e.issues.length ? `${e.message} ${e.issues.join("; ")}` : e.message;
  return "Something went wrong. Check that the local API is running.";
}

// ---- Response shapes (subset of the domain schemas the UI uses) ----

export type Disclosure = "always" | "ask" | "never";
export type FactCategory =
  | "identity"
  | "contact"
  | "employment"
  | "role"
  | "achievement"
  | "project"
  | "education"
  | "skill"
  | "certification"
  | "language"
  | "work_authorization"
  | "availability"
  | "link"
  | "other";

export const FACT_CATEGORIES: FactCategory[] = [
  "role",
  "achievement",
  "skill",
  "education",
  "certification",
  "project",
  "language",
  "link",
  "employment",
  "contact",
  "identity",
  "work_authorization",
  "availability",
  "other",
];

export interface Candidate {
  id: string;
  category: FactCategory;
  claim: string;
  evidenceText: string;
  sourceLocation: string | null;
  extractor: "deterministic" | "model";
  sensitive: boolean;
}

export interface Fact {
  id: string;
  category: FactCategory;
  claim: string;
  source: "resume" | "user-confirmed" | "imported-document";
  evidenceText?: string;
  sourceLocation?: string;
  verifiedAt: string;
  sensitive: boolean;
}

export interface ImportResult {
  kind: "pdf" | "docx";
  pageCount: number | null;
  candidates: Candidate[];
  rejectedSuggestions: number;
  warnings: string[];
  alreadyImported: boolean;
}

export interface SavedAnswer {
  id: string;
  normalizedQuestion: string;
  value: string;
  sensitivity: "none" | "personal" | "sensitive" | "protected";
  createdAt: string;
}

export interface Profile {
  version: number;
  fullName: { value: string; disclosure: Disclosure };
  email?: { value: string; disclosure: Disclosure };
  phone?: { value: string; disclosure: Disclosure };
  location?: { value: string; disclosure: Disclosure };
  links: { label: string; url: string }[];
  preferences: {
    targetRoles: string[];
    excludedRoles: string[];
    excludedCompanies: string[];
    locations: string[];
    workModes: ("remote" | "hybrid" | "onsite")[];
    willingToRelocate: boolean | null;
    compensation: {
      min: number | null;
      max: number | null;
      currency: string;
      period: "hour" | "day" | "week" | "month" | "year";
    } | null;
  };
  noticePeriod: string | null;
  availableFrom: string | null;
  languages: {
    language: string;
    level: "basic" | "conversational" | "professional" | "fluent" | "native";
  }[];
  updatedAt: string;
}

export type JobStatus =
  | "DISCOVERED"
  | "NORMALIZED"
  | "FILTERED"
  | "ELIGIBLE"
  | "SCORED"
  | "SHORTLISTED"
  | "SKIPPED"
  | "ARCHIVED";

export interface JobFetch {
  fetchedAt: string;
  outcome: "ok" | "not_modified" | "error";
  errorMessage: string | null;
  itemCount: number;
  skippedCount: number;
  newCount: number;
}

export interface JobSource {
  id: string;
  type: "greenhouse" | "lever" | "ashby";
  identifier: string;
  displayName: string | null;
  enabled: boolean;
  lastFetch: JobFetch | null;
  running: boolean;
}

export interface DiscoveryTask {
  id: string;
  sourceId: string | null;
  status: "queued" | "leased" | "done" | "failed" | "needs_human";
  attempts: number;
  lastErrorClass: string | null;
  updatedAt: string;
}

export interface JobSummary {
  id: string;
  source: string;
  sourceUrl: string;
  applyUrl: string | null;
  company: string;
  title: string;
  team: string | null;
  locations: string[];
  workMode: "remote" | "hybrid" | "onsite" | "unknown";
  employmentType: string;
  seniority: string;
  requiredQualifications: string[];
  preferredQualifications: string[];
  compensation: { min: number | null; max: number | null; currency: string; period: string } | null;
  sponsorship: {
    value: "offered" | "not_offered" | "unknown";
    confidence: number;
    evidence: string | null;
  };
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobStatus;
  filterReasons: string[];
  removedFromSourceAt: string | null;
  match?: {
    total: number;
    verdict: Verdict;
    mode: "deterministic" | "model-assisted";
    stale: boolean;
  } | null;
}

export type Verdict = "strong" | "possible" | "weak" | "disqualified";

export interface RequirementAssessment {
  key: string;
  text: string;
  kind: "required" | "preferred" | "inferred" | "unknown";
  status: "met" | "partial" | "missing" | "unknown";
  factIds: string[];
  source: "lexical" | "model";
  rationale: string;
}

export interface MatchResult {
  total: number;
  verdict: Verdict;
  dimensions: Record<string, { score: number; rationale: string; unknown: boolean }>;
  requirements: RequirementAssessment[];
  missing: string[];
  unknowns: string[];
  hardFilterReasons: string[];
  explanation: string;
  modelExplanation: string | null;
  createdAt: string;
  meta: {
    mode: "deterministic" | "model-assisted";
    provider: string | null;
    model: string | null;
    costUsd: number | null;
    modelSkippedReason: string | null;
    weights: Record<string, number>;
  };
}

export interface MatchResponse {
  match: MatchResult | null;
  stale: boolean;
  scoring: boolean;
  facts: Record<string, { claim: string; category: string; source: string }>;
}

export interface JobDetail extends JobSummary {
  descriptionText: string;
  descriptionHtmlSanitized: string | null;
}

export const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "unknown";

export const fmtComp = (c: JobSummary["compensation"]) =>
  c
    ? `${[c.min, c.max]
        .filter((x) => x !== null)
        .map((x) => x.toLocaleString())
        .join("–")} ${c.currency}/${c.period}`
    : null;

export type ResumeStatus = "draft" | "needs_attention" | "approved" | "rejected";

export interface ResumeSummary {
  id: string;
  jobId: string | null;
  status: ResumeStatus;
  length: "one-page" | "full";
  mode: "deterministic" | "model-assisted";
  createdAt: string;
  bullets: number;
  dropped: number;
  failedChecks: string[];
  artifacts: {
    html: { id: string } | null;
    pdf: { id: string } | null;
    docx: { id: string } | null;
  };
}

export interface ResumeBullet {
  id: string;
  text: string;
  sourceFactIds: string[];
  transformation: string;
  verifier: { deterministic: string; review: string };
}

export interface ResumeDetail extends ResumeSummary {
  resume: {
    header: { name: string; contact: string[]; links: { label: string; url: string }[] };
    summary: { text: string } | null;
    experience: { heading: string; bullets: ResumeBullet[] }[];
    skills: { text: string }[];
    education: { text: string }[];
    certifications: { text: string }[];
    projects: { text: string }[];
    languages: { text: string }[];
    dropped: { text: string; reason: string }[];
    meta: {
      notes: string[];
      review: string;
      generator: string | null;
      reviewer: string | null;
      regenerated: number;
    };
  };
  checks: { name: string; ok: boolean; detail: string }[];
  provenance: {
    bulletId: string;
    transformation: string;
    sources: { id: string; claim: string | null }[];
    diff: { op: "eq" | "del" | "ins"; text: string }[] | null;
  }[];
  omitted: { id: string; claim: string | null }[];
  decidedAt: string | null;
}

export type AnswerDecision = "auto_fill" | "needs_review" | "requires_user" | "prohibited";

export interface AppAnswer {
  field: {
    id: string;
    label: string;
    type: string;
    required: boolean;
    options: string[];
    category: string;
    origin: "manual" | "common" | "page";
  };
  proposedValue: string | null;
  provenance: { kind: string; label?: string; note?: string; field?: string };
  sensitivity: "none" | "personal" | "sensitive" | "protected";
  decision: AnswerDecision;
  finalValue: string | null;
  finalValueSetBy: "user" | "system" | null;
  notes: string[];
  sources: { id: string; claim: string | null }[];
}

export interface AppOverview {
  application: {
    id: string;
    state: string;
    resumeVersionId: string | null;
    coverLetterVersionId: string | null;
    coverLetterSkipped: boolean;
  };
  job: { id: string; title: string; company: string; status: string; sourceUrl: string };
  answers: AppAnswer[];
  pending: string[];
  answersComplete: boolean;
  consistency: { severity: "high" | "medium" | "low"; location: string; detail: string }[];
  materialsReady: boolean;
}

export interface AppDetail extends AppOverview {
  resumes: { id: string; status: string; length: string; createdAt: string }[];
  coverLetters: {
    id: string;
    status: "draft" | "needs_attention" | "approved" | "rejected";
    createdAt: string;
    text: string;
    mode: string;
    notes: string[];
    segments: {
      kind: "fact" | "motivation" | "courtesy";
      text: string;
      sources: (string | null)[];
    }[];
    dropped: { text: string; reason: string }[];
    checks: { name: string; ok: boolean; detail: string }[];
    artifacts: { pdf: { id: string } | null; docx: { id: string } | null };
  }[];
  coverLetterDrafting: boolean;
  browser: BrowserState;
}

export interface BrowserState {
  busy: boolean;
  session: {
    status: "active" | "handoff" | "awaiting_input" | "ready" | "closed" | "failed";
    adapter: string;
    steps: number;
    lastUrl: string | null;
    message: string | null;
    checklist: string[];
    startedAt: string;
    endedAt: string | null;
  } | null;
}

/** Plain-language application states. */
export const STATE_TEXT: Record<string, string> = {
  DRAFT: "choosing materials",
  TAILORING: "choosing materials",
  VERIFYING: "choosing materials",
  READY_TO_PREPARE: "materials ready",
  PREPARING: "preparing the form",
  AWAITING_USER_INPUT: "waiting for your answers",
  READY_FOR_REVIEW: "ready for final review",
  SUBMITTED: "submitted",
  SUBMISSION_UNCERTAIN: "submission uncertain",
  FAILED: "failed",
  WITHDRAWN: "withdrawn",
};
