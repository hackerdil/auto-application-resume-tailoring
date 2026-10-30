import type { ApplicationTransitionContext } from "./state/application.js";
import type { Application, ApplicationAnswer, ApplicationState } from "./schemas/application.js";
import type { AuditEvent } from "./schemas/audit.js";
import type { NewVerifiedFact, VerifiedFact } from "./schemas/fact.js";
import type {
  Job,
  JobRequirement,
  JobSourceType,
  JobStatus,
  RequirementKind,
} from "./schemas/job.js";
import type { MatchResult } from "./schemas/match.js";
import type { CoverLetter, TailoredResume } from "./schemas/resume.js";
import type { CandidateProfile, ProfileDraftInput, SavedAnswer } from "./schemas/profile.js";
import type { CandidateStatus, FactCandidate, NewFactCandidate } from "./schemas/candidate.js";

/** Fields the caller supplies; id and timestamp are assigned by the repository. */
export type NewAuditEvent = Omit<AuditEvent, "id" | "at">;

export interface AuditRepository {
  append(event: NewAuditEvent): AuditEvent;
  listForApplication(applicationId: string): AuditEvent[];
}

export interface UserRepository {
  /** Returns the single local owner, creating it on first use. */
  ensureOwner(displayName: string): { id: string; displayName: string };
}

export interface FactRepository {
  add(userId: string, fact: NewVerifiedFact): VerifiedFact;
  /** Appends `replacement` and marks `factId` as superseded by it, atomically. */
  supersede(userId: string, factId: string, replacement: NewVerifiedFact): VerifiedFact;
  get(factId: string): VerifiedFact | null;
  listActive(userId: string): VerifiedFact[];
}

export interface SavedAnswerRepository {
  save(answer: Omit<SavedAnswer, "id" | "createdAt" | "revokedAt">): SavedAnswer;
  findActive(userId: string, normalizedQuestion: string): SavedAnswer | null;
  listActive(userId: string): SavedAnswer[];
  revoke(id: string): void;
}

export interface UpsertJobResult {
  job: Job;
  /** "created" for a new canonical ID, "updated" when content changed, "unchanged" when only lastSeenAt moved. */
  outcome: "created" | "updated" | "unchanged";
}

export interface JobListQuery {
  statuses?: JobStatus[];
  /** Case-insensitive match on title or company. */
  search?: string;
  jobSourceId?: string;
  /** "recent" (default) or highest latest match score first. */
  sort?: "recent" | "score";
  limit: number;
  offset: number;
}

export interface JobRepository {
  /** `jobSourceId` links the job to the configured source that listed it (null for manual imports). */
  upsert(job: Job, jobSourceId?: string | null): UpsertJobResult;
  get(id: string): Job | null;
  /** Validated transition + audit event; `filterReasons` replaces the job's reasons when given. */
  transition(
    id: string,
    to: JobStatus,
    audit: { traceId: string; actor: AuditEvent["actor"] },
    patch?: { filterReasons?: string[] },
  ): Job;
  list(query: JobListQuery): { items: Job[]; total: number };
  /** Other jobs with the same normalized content (cross-source duplicates). */
  findByContentHash(contentHash: string, excludeId: string): Job[];
  /** Marks jobs of a source that were not in its latest complete listing; returns how many were marked. */
  markRemoved(jobSourceId: string, listedIds: readonly string[], at: string): number;
}

export interface JobSourceRecord {
  id: string;
  type: JobSourceType;
  identifier: string;
  displayName: string | null;
  enabled: boolean;
  allowedHosts: string[];
  createdAt: string;
}

export interface JobFetchRecord {
  id: string;
  jobSourceId: string | null;
  url: string;
  fetchedAt: string;
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  rawHash: string | null;
  outcome: "ok" | "not_modified" | "error";
  errorClass: string | null;
  errorMessage: string | null;
  itemCount: number;
  skippedCount: number;
  newCount: number;
  durationMs: number | null;
}

export interface JobSourceRepository {
  /** Throws ConflictError when the same (type, identifier) already exists. */
  add(input: Omit<JobSourceRecord, "id" | "createdAt" | "enabled">): JobSourceRecord;
  get(id: string): JobSourceRecord | null;
  list(): JobSourceRecord[];
  setEnabled(id: string, enabled: boolean): JobSourceRecord;
}

export interface JobFetchRepository {
  record(fetch: Omit<JobFetchRecord, "id">): JobFetchRecord;
  latestForSource(jobSourceId: string): JobFetchRecord | null;
  /** Latest successful (ok or not_modified) fetch, for conditional requests. */
  latestSuccessForSource(jobSourceId: string): JobFetchRecord | null;
}

export interface ArtifactRecord {
  id: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  kind: string;
  storagePath: string;
  createdAt: string;
}

export interface ArtifactRepository {
  /** Idempotent by sha256: returns the existing record when the content is already stored. */
  put(record: Omit<ArtifactRecord, "id" | "createdAt">): ArtifactRecord;
  getBySha256(sha256: string): ArtifactRecord | null;
  get(id: string): ArtifactRecord | null;
}

export interface ApplicationRepository {
  /** Throws ConflictError when an application for (user, job) already exists. */
  create(userId: string, jobId: string, traceId: string): Application;
  get(id: string): Application | null;
  findForJob(userId: string, jobId: string): Application | null;
  list(userId: string): Application[];
  /** Links the chosen résumé and cover letter (or records that no cover letter will be sent). */
  setMaterials(
    id: string,
    materials: {
      resumeVersionId?: string | null;
      coverLetterVersionId?: string | null;
      coverLetterSkipped?: boolean;
    },
  ): Application;
  /** Validates the transition, persists it, and appends the audit event in one transaction. */
  transition(
    id: string,
    to: ApplicationState,
    ctx: ApplicationTransitionContext & {
      traceId: string;
      approvalId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Application;
}

export interface TaskRecord {
  id: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  status: "queued" | "leased" | "done" | "failed" | "needs_human";
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface TaskRepository {
  /** Idempotent: the same key returns the existing task instead of enqueuing a duplicate. */
  enqueue(kind: string, payload: unknown, idempotencyKey: string): TaskRecord;
  /** Claims the oldest queued task, or one whose lease expired. Never reclaims `needs_human` tasks. */
  claim(workerId: string, leaseMs: number): TaskRecord | null;
  complete(id: string, workerId: string): void;
  fail(
    id: string,
    workerId: string,
    opts: { retry: boolean; maxAttempts: number; errorClass?: string },
  ): void;
  markNeedsHuman(id: string, workerId: string): void;
  get(id: string): TaskRecord | null;
  listRecent(
    kind: string,
    limit: number,
  ): (TaskRecord & { createdAt: string; updatedAt: string; lastErrorClass: string | null })[];
  /** True when a queued or leased task exists whose idempotency key starts with `prefix`. */
  hasActive(prefix: string): boolean;
}

export interface ProfileRepository {
  get(userId: string): CandidateProfile | null;
  /** Saves a new immutable version and points the profile at it. */
  save(userId: string, draft: ProfileDraftInput): CandidateProfile;
  listVersions(userId: string): { version: number; createdAt: string }[];
}

export interface DocumentTextRepository {
  /** Stores the extracted text of an artifact (encrypted); idempotent per artifact. */
  put(artifactId: string, text: string): void;
  get(artifactId: string): string | null;
}

export interface CandidateRepository {
  addMany(
    userId: string,
    artifactId: string,
    candidates: readonly NewFactCandidate[],
  ): FactCandidate[];
  get(id: string): FactCandidate | null;
  list(userId: string, status?: CandidateStatus): FactCandidate[];
  /** Pending → confirmed/rejected exactly once; throws ConflictError if already decided. */
  decide(
    id: string,
    decision: { status: "confirmed"; factId: string } | { status: "rejected" },
  ): FactCandidate;
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyRepository {
  /** Returns the stored response for (key, scope), or a ConflictError if the key was reused with a different request. */
  lookup(key: string, scope: string, requestHash: string): StoredResponse | null;
  save(key: string, scope: string, requestHash: string, response: StoredResponse): void;
}

/** Runs `fn` atomically; repository calls made inside join the same transaction. */
export interface UnitOfWork {
  transaction<T>(fn: () => T): T;
}

export interface MatchRepository {
  /** Stores the result as the job's current match for (profileVersion, scoringVersion), replacing an older one. */
  save(result: MatchResult): MatchResult;
  latestForJob(jobId: string): MatchResult | null;
  latestForJobs(jobIds: readonly string[]): Map<string, MatchResult>;
}

export interface JobRequirementRepository {
  replaceForJob(
    jobId: string,
    requirements: readonly {
      key: string;
      text: string;
      kind: RequirementKind;
      evidence: string | null;
    }[],
  ): void;
  listForJob(jobId: string): JobRequirement[];
}

export interface ProviderRunRecord {
  traceId: string;
  agentRunId: string | null;
  provider: string;
  model: string | null;
  taskType: string;
  promptId: string | null;
  promptVersion: string | null;
  requestId: string | null;
  durationMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  toolCalls: number;
  delegated: boolean;
  fallback: boolean;
  errorClass: string | null;
}

export interface ProviderRunRepository {
  record(run: ProviderRunRecord): void;
  /** Sum of recorded costs since `sinceIso` (unknown costs count as 0). */
  costSince(sinceIso: string): number;
  /** Usage per provider and task since `sinceIso` (Phase 9 usage page). */
  usageSince(sinceIso: string): ProviderUsageRow[];
}

export interface ProviderUsageRow {
  provider: string;
  taskType: string;
  calls: number;
  errors: number;
  fallbacks: number;
  delegated: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs; `unpricedCalls` successful calls reported no cost. */
  costUsd: number;
  unpricedCalls: number;
}

export type ResumeStatus = "draft" | "needs_attention" | "approved" | "rejected";

export interface ResumeArtifactRef {
  id: string;
  sha256: string;
}

export interface ResumeVersionRecord {
  resume: TailoredResume;
  status: ResumeStatus;
  artifacts: {
    html: ResumeArtifactRef | null;
    pdf: ResumeArtifactRef | null;
    docx: ResumeArtifactRef | null;
  };
  checks: { name: string; ok: boolean; detail: string }[];
  createdAt: string;
  decidedAt: string | null;
}

export interface ResumeVersionRepository {
  /** Stores the structured résumé, its bullets, and artifact links in one transaction. Immutable afterwards. */
  create(input: {
    resume: TailoredResume;
    status: "draft" | "needs_attention";
    artifactIds: { html: string; pdf: string; docx: string };
    checks: { name: string; ok: boolean; detail: string }[];
  }): ResumeVersionRecord;
  get(id: string): ResumeVersionRecord | null;
  listForJob(jobId: string): ResumeVersionRecord[];
  /** draft → approved | rejected, once. */
  decide(id: string, status: "approved" | "rejected"): ResumeVersionRecord;
}

export interface ApplicationFieldRepository {
  /** Adds fields with their planned answers (values encrypted at rest). */
  add(applicationId: string, answers: readonly ApplicationAnswer[]): ApplicationAnswer[];
  list(applicationId: string): ApplicationAnswer[];
  /** Replaces the stored answer for a field (the field itself is immutable). */
  saveAnswer(applicationId: string, answer: ApplicationAnswer): ApplicationAnswer;
  /** Removes a field the owner added by hand, with its answer. */
  remove(applicationId: string, fieldId: string): void;
}

export type CoverLetterStatus = "draft" | "needs_attention" | "approved" | "rejected";

export interface CoverLetterRecord {
  letter: CoverLetter;
  status: CoverLetterStatus;
  text: string;
  artifacts: {
    html: ResumeArtifactRef | null;
    pdf: ResumeArtifactRef | null;
    docx: ResumeArtifactRef | null;
  };
  checks: { name: string; ok: boolean; detail: string }[];
  createdAt: string;
  decidedAt: string | null;
}

export interface CoverLetterRepository {
  create(input: {
    letter: CoverLetter;
    status: "draft" | "needs_attention";
    text: string;
    artifactIds: { html: string; pdf: string; docx: string };
    checks: { name: string; ok: boolean; detail: string }[];
  }): CoverLetterRecord;
  get(id: string): CoverLetterRecord | null;
  listForApplication(applicationId: string): CoverLetterRecord[];
  decide(id: string, status: "approved" | "rejected"): CoverLetterRecord;
}

export type BrowserSessionStatus =
  "active" | "handoff" | "awaiting_input" | "ready" | "closed" | "failed";

/** One application's browser preparation session (spec §13). URLs are stored without query or fragment. */
export interface BrowserSessionRecord {
  id: string;
  applicationId: string;
  status: BrowserSessionStatus;
  adapter: string;
  originAllowlist: string[];
  /** Why control was handed to the owner (sign-in, CAPTCHA, a field only they complete). */
  handoffReason: string | null;
  steps: number;
  lastUrl: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Phase 8: the latest review snapshot of the filled form, taken by the worker. */
  review: ReviewSnapshot | null;
}

export interface ReviewSnapshot {
  formSnapshotHash: string;
  url: string;
  origin: string;
  /** Null when the adapter found no single, unambiguous submit control. */
  submitControl: import("./schemas/approval.js").SubmitControlIdentity | null;
  /** Readiness items still open when the snapshot was taken (empty = approvable). */
  checklist: string[];
  takenAt: string;
}

export interface BrowserSessionRepository {
  start(
    applicationId: string,
    input: { adapter: string; originAllowlist: readonly string[] },
  ): BrowserSessionRecord;
  update(
    id: string,
    patch: Partial<Pick<BrowserSessionRecord, "status" | "handoffReason" | "steps" | "lastUrl">>,
  ): BrowserSessionRecord;
  end(id: string, status: "closed" | "failed"): void;
  recordReview(id: string, review: ReviewSnapshot): BrowserSessionRecord;
  latest(applicationId: string): BrowserSessionRecord | null;
  /** Marks sessions left open by a previous worker process as closed; returns how many. */
  endAllOpen(): number;
}

export interface ApprovalRecord {
  id: string;
  applicationId: string;
  tokenHash: string;
  bindingJson: string;
  bindingMac: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface ApprovalRepository {
  /** Revokes any active approval for the application, then stores the new one. */
  issue(
    input: Omit<ApprovalRecord, "id" | "consumedAt" | "revokedAt" | "revokeReason"> & {
      id: string;
    },
  ): ApprovalRecord;
  get(id: string): ApprovalRecord | null;
  active(applicationId: string): ApprovalRecord | null;
  /** Revokes an active approval; returns false when it was already consumed, revoked, or unknown. */
  revoke(id: string, reason: string): boolean;
  revokeAllActive(applicationId: string, reason: string): number;
  /** Single conditional UPDATE: true only when exactly one active, unexpired row was consumed. */
  consume(id: string, nowIso: string): boolean;
}

export interface SubmissionAttemptRecord {
  id: string;
  applicationId: string;
  approvalId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: import("./schemas/approval.js").SubmissionOutcome | null;
  evidence: import("./schemas/approval.js").SubmissionEvidence | null;
}

export interface SubmissionAttemptRepository {
  /** At most one attempt per approval (unique). */
  start(applicationId: string, approvalId: string): SubmissionAttemptRecord;
  finish(
    id: string,
    outcome: import("./schemas/approval.js").SubmissionOutcome,
    evidence: import("./schemas/approval.js").SubmissionEvidence,
  ): SubmissionAttemptRecord;
  latest(applicationId: string): SubmissionAttemptRecord | null;
}
