// Drizzle schema for the local SQLite store. Mirrors docs/DATA_MODEL.md.
// Conventions: UUIDv7 text ids (jobs use canonical `source:externalId`), epoch-ms integer timestamps,
// JSON stored as text, `*_enc` columns hold AES-GCM ciphertext from @career-agent/security (ADR-005).
// This file must only import from drizzle-orm: drizzle-kit loads it directly.

import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () => integer("created_at").notNull();
const json = (name: string) => text(name, { mode: "json" });

export const APPLICATION_STATES = [
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
] as const;

export const JOB_STATUSES = [
  "DISCOVERED",
  "NORMALIZED",
  "FILTERED",
  "ELIGIBLE",
  "SCORED",
  "SHORTLISTED",
  "SKIPPED",
  "ARCHIVED",
] as const;

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

export const users = sqliteTable("users", {
  id: id(),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

export const artifacts = sqliteTable("artifacts", {
  id: id(),
  sha256: text("sha256").notNull().unique(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  kind: text("kind").notNull(),
  storagePath: text("storage_path").notNull(),
  createdAt: createdAt(),
});

export const candidateProfiles = sqliteTable("candidate_profiles", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  currentVersion: integer("current_version").notNull(),
  dataEnc: text("data_enc").notNull(),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull(),
});

export const profileVersions = sqliteTable(
  "profile_versions",
  {
    id: id(),
    profileId: text("profile_id")
      .notNull()
      .references(() => candidateProfiles.id),
    version: integer("version").notNull(),
    dataEnc: text("data_enc").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("profile_versions_profile_version_uq").on(t.profileId, t.version)],
);

export const facts = sqliteTable(
  "facts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    category: text("category").notNull(),
    /** Plaintext for non-sensitive facts; ciphertext when `sensitive = 1`. */
    claim: text("claim").notNull(),
    source: text("source").notNull(),
    sourceArtifactId: text("source_artifact_id").references(() => artifacts.id),
    sourceLocation: text("source_location"),
    evidenceText: text("evidence_text"),
    verifiedAt: integer("verified_at").notNull(),
    supersededBy: text("superseded_by"),
    allowedTransformations: json("allowed_transformations").$type<string[]>().notNull(),
    sensitive: integer("sensitive", { mode: "boolean" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("facts_user_active_idx").on(t.userId, t.supersededBy),
    check("facts_source_ck", inList("source", ["resume", "user-confirmed", "imported-document"])),
  ],
);

export const factSources = sqliteTable("fact_sources", {
  id: id(),
  factId: text("fact_id")
    .notNull()
    .references(() => facts.id),
  artifactId: text("artifact_id").references(() => artifacts.id),
  location: text("location"),
  evidenceText: text("evidence_text"),
  createdAt: createdAt(),
});

export const savedAnswers = sqliteTable(
  "saved_answers",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    normalizedQuestion: text("normalized_question").notNull(),
    valueEnc: text("value_enc").notNull(),
    sensitivity: text("sensitivity").notNull(),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("saved_answers_active_uq")
      .on(t.userId, t.normalizedQuestion)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const jobSources = sqliteTable(
  "job_sources",
  {
    id: id(),
    type: text("type").notNull(),
    identifier: text("identifier").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    config: json("config").$type<Record<string, unknown>>().notNull(),
    originAllowlist: json("origin_allowlist").$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("job_sources_type_identifier_uq").on(t.type, t.identifier)],
);

export const companies = sqliteTable("companies", {
  id: id(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  createdAt: createdAt(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    /** Canonical `source:externalId`. */
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    companyId: text("company_id").references(() => companies.id),
    /** The configured source that last listed this job; null for manually imported jobs. */
    jobSourceId: text("job_source_id").references(() => jobSources.id),
    data: json("data").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    sourceHash: text("source_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_uq").on(t.source, t.externalId),
    index("jobs_content_hash_idx").on(t.contentHash),
    index("jobs_status_idx").on(t.status),
    index("jobs_source_idx").on(t.jobSourceId),
    check("jobs_status_ck", inList("status", JOB_STATUSES)),
  ],
);

export const jobRequirements = sqliteTable(
  "job_requirements",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    requirementKey: text("requirement_key").notNull(),
    text: text("text").notNull(),
    kind: text("kind").notNull(),
    evidence: text("evidence"),
  },
  (t) => [uniqueIndex("job_requirements_job_key_uq").on(t.jobId, t.requirementKey)],
);

export const jobFetches = sqliteTable("job_fetches", {
  id: id(),
  jobSourceId: text("job_source_id").references(() => jobSources.id),
  url: text("url").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  httpStatus: integer("http_status"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  rawHash: text("raw_hash"),
  outcome: text("outcome").notNull().default("ok"),
  errorClass: text("error_class"),
  /** User-safe error summary (never raw response bodies). */
  errorMessage: text("error_message"),
  itemCount: integer("item_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  durationMs: integer("duration_ms"),
});

export const matchResults = sqliteTable(
  "match_results",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    profileVersion: integer("profile_version").notNull(),
    scoringVersion: text("scoring_version").notNull(),
    total: real("total").notNull(),
    verdict: text("verdict").notNull(),
    data: json("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("match_results_uq").on(t.jobId, t.profileVersion, t.scoringVersion)],
);

export const resumeTemplates = sqliteTable("resume_templates", {
  id: id(),
  name: text("name").notNull().unique(),
  version: text("version").notNull(),
  createdAt: createdAt(),
});

export const RESUME_STATUSES = ["draft", "needs_attention", "approved", "rejected"] as const;

export const resumeVersions = sqliteTable(
  "resume_versions",
  {
    id: id(),
    jobId: text("job_id").references(() => jobs.id),
    profileVersion: integer("profile_version").notNull(),
    templateId: text("template_id").references(() => resumeTemplates.id),
    structured: json("structured").$type<Record<string, unknown>>().notNull(),
    /** draft (verified, awaiting the owner) → approved | rejected; needs_attention when render checks failed. Enforced by trigger (migration 0006). */
    status: text("status").notNull(),
    length: text("length").notNull().default("one-page"),
    htmlArtifactId: text("html_artifact_id").references(() => artifacts.id),
    pdfArtifactId: text("pdf_artifact_id").references(() => artifacts.id),
    docxArtifactId: text("docx_artifact_id").references(() => artifacts.id),
    checks: json("checks").$type<unknown[]>().notNull().default([]),
    decidedAt: integer("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("resume_versions_job_idx").on(t.jobId, t.createdAt)],
);

export const resumeBullets = sqliteTable(
  "resume_bullets",
  {
    id: id(),
    resumeVersionId: text("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    sourceFactIds: json("source_fact_ids").$type<string[]>().notNull(),
    targetRequirementKeys: json("target_requirement_keys").$type<string[]>().notNull(),
    transformation: text("transformation").notNull(),
    deterministicStatus: text("deterministic_status").notNull(),
    reviewStatus: text("review_status").notNull(),
    findings: json("findings").$type<unknown[]>().notNull(),
  },
  (t) => [
    uniqueIndex("resume_bullets_ordinal_uq").on(t.resumeVersionId, t.ordinal),
    check("resume_bullets_has_facts_ck", sql`json_array_length(source_fact_ids) >= 1`),
  ],
);

export const applications = sqliteTable(
  "applications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    state: text("state").notNull(),
    resumeVersionId: text("resume_version_id").references(() => resumeVersions.id),
    coverLetterVersionId: text("cover_letter_version_id").references(
      (): AnySQLiteColumn => coverLetterVersions.id,
    ),
    coverLetterSkipped: integer("cover_letter_skipped", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("applications_user_job_uq").on(t.userId, t.jobId),
    check("applications_state_ck", inList("state", APPLICATION_STATES)),
  ],
);

export const applicationFields = sqliteTable(
  "application_fields",
  {
    id: id(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    normalizedQuestion: text("normalized_question").notNull(),
    type: text("type").notNull(),
    required: integer("required", { mode: "boolean" }).notNull(),
    options: json("options").$type<string[]>().notNull(),
    snapshotGeneration: integer("snapshot_generation").notNull(),
    category: text("category").notNull().default("unknown"),
    /** manual (owner added), common (standard set), page (read from the application form, Phase 7). */
    origin: text("origin").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("application_fields_key_uq").on(t.applicationId, t.fieldKey)],
);

export const applicationAnswers = sqliteTable(
  "application_answers",
  {
    id: id(),
    fieldId: text("field_id")
      .notNull()
      .unique()
      .references(() => applicationFields.id),
    proposedValueEnc: text("proposed_value_enc"),
    finalValueEnc: text("final_value_enc"),
    finalValueSetBy: text("final_value_set_by"),
    provenance: json("provenance").$type<Record<string, unknown>>().notNull(),
    confidence: real("confidence").notNull(),
    sensitivity: text("sensitivity").notNull(),
    decision: text("decision").notNull(),
    reviewerChanges: json("reviewer_changes").$type<string[]>().notNull(),
    notes: json("notes").$type<string[]>().notNull().default([]),
    updatedAt: integer("updated_at").notNull(),
  },
  () => [
    check(
      "application_answers_decision_ck",
      inList("decision", ["auto_fill", "needs_review", "requires_user", "prohibited"]),
    ),
    check(
      "application_answers_prohibited_empty_ck",
      sql`decision <> 'prohibited' OR final_value_enc IS NULL`,
    ),
    check(
      "application_answers_user_only_ck",
      sql`decision <> 'requires_user' OR final_value_enc IS NULL OR final_value_set_by = 'user'`,
    ),
  ],
);

export const applicationApprovals = sqliteTable(
  "application_approvals",
  {
    id: id(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id),
    tokenHash: text("token_hash").notNull(),
    bindingJson: text("binding_json").notNull(),
    bindingMac: text("binding_mac").notNull(),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    revokedAt: integer("revoked_at"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    uniqueIndex("application_approvals_one_active_uq")
      .on(t.applicationId)
      .where(sql`consumed_at IS NULL AND revoked_at IS NULL`),
    check("application_approvals_not_both_ck", sql`consumed_at IS NULL OR revoked_at IS NULL`),
  ],
);

export const browserSessions = sqliteTable("browser_sessions", {
  id: id(),
  applicationId: text("application_id").references(() => applications.id),
  status: text("status").notNull(),
  originAllowlist: json("origin_allowlist").$type<string[]>().notNull(),
  preserved: integer("preserved", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  /** Phase 7: ATS adapter id, why control went to the owner, tool steps used, last page (no query). */
  adapter: text("adapter").notNull().default("generic"),
  handoffReason: text("handoff_reason"),
  steps: integer("steps").notNull().default(0),
  lastUrl: text("last_url"),
  /** Phase 8: latest review snapshot (hash, submit control, checklist), see docs/APPROVAL_MODEL.md. */
  review: json("review").$type<Record<string, unknown>>(),
});

export const submissionAttempts = sqliteTable("submission_attempts", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  approvalId: text("approval_id")
    .notNull()
    .unique()
    .references(() => applicationApprovals.id),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  outcome: text("outcome"),
  evidence: json("evidence").$type<Record<string, unknown>>(),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: id(),
  traceId: text("trace_id").notNull(),
  kind: text("kind").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  limits: json("limits").$type<Record<string, unknown>>().notNull(),
  counters: json("counters").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  errorClass: text("error_class"),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
});

export const providerRuns = sqliteTable(
  "provider_runs",
  {
    id: id(),
    traceId: text("trace_id").notNull(),
    agentRunId: text("agent_run_id").references(() => agentRuns.id),
    provider: text("provider").notNull(),
    model: text("model"),
    taskType: text("task_type").notNull(),
    promptId: text("prompt_id"),
    promptVersion: text("prompt_version"),
    requestId: text("request_id"),
    durationMs: integer("duration_ms").notNull(),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: real("cost_usd"),
    toolCalls: integer("tool_calls").notNull().default(0),
    delegated: integer("delegated", { mode: "boolean" }).notNull().default(false),
    fallback: integer("fallback", { mode: "boolean" }).notNull().default(false),
    errorClass: text("error_class"),
    createdAt: createdAt(),
  },
  (t) => [index("provider_runs_trace_idx").on(t.traceId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    kind: text("kind").notNull(),
    payload: json("payload").$type<unknown>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    availableAt: integer("available_at").notNull(),
    lastErrorClass: text("last_error_class"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("tasks_claim_idx").on(t.status, t.availableAt),
    check(
      "tasks_status_ck",
      inList("status", ["queued", "leased", "done", "failed", "needs_human"]),
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: id(),
    at: integer("at").notNull(),
    traceId: text("trace_id").notNull(),
    runId: text("run_id"),
    taskId: text("task_id"),
    applicationId: text("application_id"),
    jobId: text("job_id"),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    prevState: text("prev_state"),
    newState: text("new_state"),
    approvalId: text("approval_id"),
    artifactHashes: json("artifact_hashes").$type<string[]>().notNull(),
    provider: text("provider"),
    model: text("model"),
    durationMs: integer("duration_ms"),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index("audit_events_application_idx").on(t.applicationId, t.at),
    index("audit_events_trace_idx").on(t.traceId),
    check(
      "audit_events_actor_ck",
      inList("actor", ["user", "system", "openai", "claude", "browser"]),
    ),
  ],
);

export const followUps = sqliteTable("follow_ups", {
  id: id(),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id),
  kind: text("kind").notNull(),
  note: text("note"),
  dueAt: integer("due_at").notNull(),
  doneAt: integer("done_at"),
  createdAt: createdAt(),
});

export const factCandidates = sqliteTable(
  "fact_candidates",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    category: text("category").notNull(),
    /** Always encrypted: candidates are raw résumé excerpts and may include personal data. */
    claimEnc: text("claim_enc").notNull(),
    evidenceEnc: text("evidence_enc").notNull(),
    sourceLocation: text("source_location"),
    extractor: text("extractor").notNull(),
    sensitive: integer("sensitive", { mode: "boolean" }).notNull(),
    status: text("status").notNull(),
    factId: text("fact_id").references(() => facts.id),
    createdAt: createdAt(),
    decidedAt: integer("decided_at"),
  },
  (t) => [
    index("fact_candidates_user_status_idx").on(t.userId, t.status),
    check("fact_candidates_status_ck", inList("status", ["pending", "confirmed", "rejected"])),
    check(
      "fact_candidates_decision_ck",
      sql`(status = 'pending' AND fact_id IS NULL AND decided_at IS NULL) OR (status = 'confirmed' AND fact_id IS NOT NULL AND decided_at IS NOT NULL) OR (status = 'rejected' AND fact_id IS NULL AND decided_at IS NOT NULL)`,
    ),
  ],
);

export const documentTexts = sqliteTable("document_texts", {
  artifactId: text("artifact_id")
    .primaryKey()
    .references(() => artifacts.id),
  textEnc: text("text_enc").notNull(),
  createdAt: createdAt(),
});

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    /** Encrypted when a cipher is configured: responses can contain personal data. */
    responseEnc: text("response_enc").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_keys_key_scope_uq").on(t.key, t.scope)],
);

/** Immutable cover letter versions; status rules are enforced by triggers (migration 0008). */
export const coverLetterVersions = sqliteTable(
  "cover_letter_versions",
  {
    id: id(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    structured: json("structured").$type<Record<string, unknown>>().notNull(),
    text: text("text").notNull(),
    status: text("status").notNull(),
    htmlArtifactId: text("html_artifact_id").references(() => artifacts.id),
    pdfArtifactId: text("pdf_artifact_id").references(() => artifacts.id),
    docxArtifactId: text("docx_artifact_id").references(() => artifacts.id),
    checks: json("checks").$type<unknown[]>().notNull().default([]),
    decidedAt: integer("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("cover_letter_versions_app_idx").on(t.applicationId, t.createdAt)],
);
