# Data Model

Zod schemas in `packages/domain` are the runtime source of truth; Drizzle tables in `packages/db` mirror them. All IDs are UUIDv7 (ADR-015) except canonical job IDs (`source:externalId`). All timestamps are UTC ISO-8601 strings in the domain and integer epoch-ms in SQLite. 🔒 = encrypted column (ADR-005).

## 1. Tables

| Table                   | Purpose                                                                                                                   | Key constraints                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `users`                 | Single local owner                                                                                                        | one row enforced by check in Phase 1                                         |
| `candidate_profiles`    | Current profile pointer per user; preferences, disclosure settings                                                        | FK users; 🔒 contact fields, compensation, demographic defaults              |
| `profile_versions`      | Immutable profile snapshots                                                                                               | UNIQUE(profile_id, version)                                                  |
| `facts`                 | Append-only verified facts                                                                                                | `superseded_by` FK facts; no UPDATE except setting `superseded_by` once      |
| `fact_sources`          | Provenance: artifact, location, evidence text                                                                             | FK facts, artifacts                                                          |
| `saved_answers`         | Explicit user answers to recurring questions                                                                              | 🔒 value; `sensitivity`; UNIQUE(user_id, normalized_question) among active   |
| `job_sources`           | Configured sources (type, board token, enabled, allowlist)                                                                | UNIQUE(type, identifier)                                                     |
| `companies`             | Normalized companies                                                                                                      | UNIQUE(normalized_name)                                                      |
| `jobs`                  | Canonical jobs                                                                                                            | PK canonical id; `source_hash`, `content_hash`; status                       |
| `job_requirements`      | Requirement list with stable IDs                                                                                          | UNIQUE(job_id, requirement_key)                                              |
| `job_fetches`           | Per-fetch log: url, time, status, etag, hash                                                                              | FK job_sources                                                               |
| `match_results`         | Scores, dimensions, evidence JSON, prompt/model version                                                                   | FK jobs; UNIQUE(job_id, profile_version, scoring_version)                    |
| `resume_templates`      | Template metadata                                                                                                         |                                                                              |
| `resume_versions`       | Structured tailored résumé (JSON)                                                                                         | FK jobs, profile_versions                                                    |
| `resume_bullets`        | Bullet text, `fact_ids`, `requirement_ids`, transformation, verifier status/findings                                      | FK resume_versions                                                           |
| `artifacts`             | Immutable files, SHA-256 addressed                                                                                        | UNIQUE(sha256); no UPDATE/DELETE except retention purge                      |
| `applications`          | One per (user, job)                                                                                                       | UNIQUE(user_id, job_id) — prevents double application; state                 |
| `application_fields`    | Detected form fields (label, type, options, required, adapter key)                                                        | FK applications                                                              |
| `application_answers`   | Proposed/approved values, provenance, decision                                                                            | 🔒 values; FK fields                                                         |
| `application_approvals` | Approval tokens (ADR-006)                                                                                                 | `token_hash`, binding JSON + HMAC, `expires_at`, `consumed_at`, `revoked_at` |
| `browser_sessions`      | Context lifecycle, origin allowlist, status, adapter, hand-off message, review snapshot (hash, submit control, checklist) | FK applications; status trigger; immutable once ended                        |
| `submission_attempts`   | One per consumed approval: outcome and redacted evidence (URL without query, title, headings, errors, writes sent)        | unique `approval_id`; needs a consumed approval; append-only once finished   |
| `provider_runs`         | Each provider call: provider, model, usage, cost, error class                                                             | trace_id indexed                                                             |
| `agent_runs`            | Workflow run: limits, counters, status                                                                                    | idempotency_key UNIQUE                                                       |
| `tasks`                 | Worker queue with leases (ADR-012)                                                                                        | idempotency_key UNIQUE                                                       |
| `audit_events`          | Append-only consequential events                                                                                          | no UPDATE/DELETE (trigger)                                                   |
| `follow_ups`            | Reminders and outcomes                                                                                                    | FK applications                                                              |

## 2. Key schemas (abridged — full definitions in Phase 1 code)

- **VerifiedFact**: `id, category, claim, source ∈ {resume,user-confirmed,imported-document}, sourceArtifactId?, sourceLocation?, evidenceText?, verifiedAt, supersededBy?, allowedTransformations ⊆ {select,reorder,shorten,rephrase,combine}, sensitive`.
- **Job**: canonical id, source, externalId, sourceUrl, applyUrl, company, title, team, locations[], workMode ∈ {remote,hybrid,onsite,unknown}, employmentType, seniority, descriptionText, descriptionHtmlSanitized, requiredQualifications[], preferredQualifications[], compensation {min,max,currency,period}|null, sponsorshipSignal {value, confidence, evidence}, postedAt, updatedAt, firstSeenAt, lastSeenAt, sourceHash, contentHash, status, filterReasons[].
- **MatchResult**: total 0–100, dimensions (9; each {score, rationale, unknown}; weights summing to 1), verdict ∈ {strong,possible,weak,disqualified}, requirements[{key, text, kind, status ∈ met|partial|missing|unknown, factIds (≥1 when met/partial), source ∈ lexical|model, rationale}], matched, missing, unknowns, hardFilterReasons, explanation (deterministic), modelExplanation (shown separately), meta {scoringVersion, mode, inputsHash, weights, promptId, promptVersion, provider, model, costUsd, modelSkippedReason}. Stored in `match_results` (one row per job × profile version × scoring version; re-scoring replaces it).
- **TailoredBullet**: text, sourceFactIds (≥1), targetRequirementKeys, transformation, verifier {deterministic, review, findings}.
- **TailoredResume**: header (name + contact fields shared "always" + links), summary (cited) | null, experience[{roleFactId, heading (verbatim role fact), bullets}], skills/education/certifications/projects/languages (verbatim fact items), dropped[{text, sourceFactIds, reason}], omittedFactIds, meta {mode, generator, reviewer, review, regenerated, promptIds, notes}. Stored in `resume_versions.structured` with links to HTML/PDF/DOCX artifacts and render checks; bullets also in `resume_bullets`. Immutable except one draft → approved/rejected decision.
- **ApplicationAnswer** (Phase 6): field {id,label,normalizedQuestion,type,required,options,category,origin}, proposedValue, provenance ∈ facts | saved_answer | profile | owner_default | artifact | draft | user | none, confidence, sensitivity, decision, reviewerChanges, finalValue (+ setBy), notes. Values encrypted in `application_answers`; `needs_review`/`requires_user` finalized only by the owner; `prohibited` never has a value.
- **CoverLetter**: greeting, paragraphs of segments {kind ∈ fact | motivation | courtesy, text, factIds, transformation}, closing, signature, dropped, meta. Stored in `cover_letter_versions` (immutable, one approve/reject decision).
- **AuditEvent**: id, at, traceId, runId?, taskId?, applicationId?, actor ∈ {user,system,openai,claude,browser}, type, prevState?, newState?, approvalId?, artifactHashes[], provider?, model?, durationMs?, usage?, metadata (redacted JSON).

## 3. State machines

### Job

| From                           | To                                      |
| ------------------------------ | --------------------------------------- |
| DISCOVERED                     | NORMALIZED                              |
| NORMALIZED                     | FILTERED, ELIGIBLE                      |
| ELIGIBLE                       | SCORED                                  |
| SCORED                         | SHORTLISTED, SKIPPED, SCORED (re-score) |
| FILTERED, SKIPPED, SHORTLISTED | ARCHIVED                                |

### Application

| From                         | To                                                       | Guard                                                                                                         |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| DRAFT                        | TAILORING, WITHDRAWN                                     |                                                                                                               |
| TAILORING                    | VERIFYING, FAILED, WITHDRAWN                             |                                                                                                               |
| VERIFYING                    | READY_TO_PREPARE, TAILORING, FAILED, WITHDRAWN           | READY_TO_PREPARE only if all artifacts verified                                                               |
| READY_TO_PREPARE             | PREPARING, WITHDRAWN                                     | mode ≠ research-only                                                                                          |
| PREPARING                    | AWAITING_USER_INPUT, READY_FOR_REVIEW, FAILED, WITHDRAWN | READY_FOR_REVIEW only if answer set complete (no `requires_user` without final value, no `prohibited` filled) |
| AWAITING_USER_INPUT          | PREPARING, WITHDRAWN                                     |                                                                                                               |
| READY_FOR_REVIEW             | APPROVED_TO_SUBMIT, PREPARING, WITHDRAWN                 | APPROVED_TO_SUBMIT only with active token; mode = review-each                                                 |
| APPROVED_TO_SUBMIT           | SUBMITTING, READY_FOR_REVIEW                             | READY_FOR_REVIEW on revoke/expiry/mismatch                                                                    |
| SUBMITTING                   | SUBMITTED, SUBMISSION_UNCERTAIN, FAILED                  | SUBMITTED only with confirmation evidence                                                                     |
| SUBMISSION_UNCERTAIN         | SUBMITTED, FAILED                                        | actor must be `user`                                                                                          |
| SUBMITTED, FAILED, WITHDRAWN | —                                                        | terminal (FAILED → new application requires explicit user action)                                             |

Invalid transitions throw `InvalidTransitionError`; every valid transition persists an `AuditEvent` atomically.
