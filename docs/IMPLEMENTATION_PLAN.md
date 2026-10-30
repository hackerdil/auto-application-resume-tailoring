# Implementation Plan

Phases follow the master specification §32. Every phase ends with `pnpm check` (format, lint, typecheck, tests) green plus relevant integration tests, and a phase report (changed files, results, risks, next phase). Tests are never skipped or weakened to pass. Default tests use fakes/fixtures only.

Status legend: ☐ not started · ◐ in progress · ☑ done

## Phase 0 — Discovery and design ☑

- Inspect repo/runtime (empty repo; Node 26.3.1 local; pnpm 10.34.9 installed).
- Verify package choices and SDK option names (ADR-001…016).
- Docs: ARCHITECTURE, THREAT_MODEL, DECISIONS, DATA_MODEL, APPROVAL_MODEL, PROMPT_SECURITY; stubs for OPERATIONS, USER_GUIDE.
- Root config: workspace, strict tsconfig, ESLint (with `no-restricted-imports` boundary for submission), Prettier, Vitest, `.gitignore`, `.env.example`, CI skeleton.
- Claude Code: `CLAUDE.md`, path-scoped rules, 6 skills, 3 read-only subagents, `settings.json` with deny rules, tested PreToolUse guard hook.
- Fixture PII/secret scan test.
- **Exit:** docs internally consistent; only scaffolding code; `pnpm check` green.

## Phase 1 — Domain foundation ☑

- `packages/domain`: Zod schemas (profile, fact, job, match, résumé, answer, audit event, run limits), UUIDv7, error taxonomy (domain + provider error classes), job and application state machines with guards, repository interfaces, `ModePolicy`.
- `packages/config`: env schema from `.env.example`, actionable errors.
- `packages/security`: AES-GCM field encryption, redaction, URL/origin policy (SSRF), path safety, canonical JSON + hashing.
- `packages/observability`: Pino with redaction, trace IDs.
- `packages/db`: Drizzle schema for all tables in DATA_MODEL, migrations, repositories, append-only audit trigger, transactional transitions.
- **Tests:** transitions (valid/invalid exhaustively), redaction, encryption, URL policy, migration on fresh DB, constraint/idempotency tests.
- **Done (2026-10-29):** 186 tests green. SQLite enforces invariants independently of repositories (9 triggers + CHECK/partial-unique constraints: append-only audit/facts, immutable artifacts, single owner, single-use approvals, terminal states, prohibited/user-only answers, bullets need ≥1 fact). `pnpm db:migrate` is live.
- **Deferred:** "upgrade an older fixture DB" test needs a second schema version; added with the first schema change (Phase 2). `profile`/`job_sources`/`match`/`approval` repositories land with the phases that use them.

## Phase 2 — Onboarding and fact bank ☑

Résumé import (unpdf/mammoth, limits), extraction to candidate facts (fake provider in tests), confirm/reject/correct API with supersession, profile/preferences/saved answers, disclosure settings, export/delete CLI. API server (Fastify, loopback, CSRF, session) and first web screens (onboarding, fact bank).

- **Done (2026-10-29):** 255 tests green; `pnpm build` (incl. `next build`) green; manual smoke run of API + production web build against a throwaway DB (import → review → confirm/reject → profile save → export → delete).
  - `packages/documents`: content-sniffed PDF/DOCX import (unpdf, mammoth) with size/page/text limits and a central-directory zip-bomb guard; content-addressed owner-only artifact store; deterministic candidate extraction plus optional model extraction whose evidence must be verbatim and whose numbers must appear in the evidence.
  - `packages/ai`: provider interface, untrusted-content envelope, prompt secret guard, `runStructured` (one repair attempt), versioned `resume-extraction` prompt. `packages/testkit`: fake provider, in-memory PDF/DOCX/ZIP generators.
  - Domain services (`FactBankService`, `ProfileService`) over repository ports + unit of work. Migrations 0002–0003 (candidates, document texts, idempotency keys); schema-upgrade test from the Phase 1 schema.
  - Fastify API (ADR-019) and Next.js UI: onboarding/privacy, fact bank, profile & preferences, saved answers, export. CLIs: `pnpm data:export`, `pnpm data:delete`.
- **Deferred:** provider-backed extraction is wired but has no real provider until Phase 9 (UI says suggestions are rule-based). Scanned/image-only résumés (OCR) are unsupported. Demographic defaults have a schema but no UI (explicit opt-in screen later). UI E2E tests arrive with Playwright in Phase 7.

## Phase 3 — Job discovery ☑

`JobSourceAdapter` interface; Greenhouse, Lever, Ashby adapters with fixture contract tests; manual URL import through SSRF-safe fetcher; normalization, content hashing, dedupe, freshness, hard filters; per-origin rate limit/backoff; source config UI; job inbox.

- **Done (2026-10-29):** 319 tests green; `pnpm build` green; UI smoke run on a throwaway DB seeded through the real discovery service with fixture HTTP (inbox, filter reasons, failed-source display, sanitized job detail; no console errors).
  - `packages/security/safe-http`: SSRF-safe GET with DNS pinning (ADR-023). `packages/sources` (ADR-022): paced, retrying HTTP client with conditional requests; Greenhouse/Lever/Ashby adapters (API shapes checked against current docs); JSON-LD-only generic reader; URL import routing; HTML sanitizer and text extraction; deterministic normalization (seniority from title words only, work mode, employment type, compensation, sponsorship signal with evidence, required/preferred qualifications from headings); stable source and content hashes.
  - Domain: deterministic hard filters (unknown values never filter) and `DiscoveryService` (isolation of source failures, cross-source duplicate detection, removed-posting tracking, owner shortlist/skip/archive through the state machine).
  - DB migration 0004 (job → source link, fetch outcomes and counts); schema-upgrade test now derives the migration count from the journal.
  - Worker app: leased task loop for discovery; transient failures retried with backoff, permanent ones fail visibly.
  - API: sources, discovery queueing (no overlapping runs per source), job list/detail/status, URL import. UI: Sources page, Job inbox with views/search/paging, job detail.
- **Not done / deferred:** scheduled discovery (`DISCOVERY_SCHEDULE_ENABLED` logs a warning; cron runner later). Workable adapter (ADR-022). Live source contract tests (`ENABLE_LIVE_SOURCE_TESTS`) not written; no real job board was contacted. Filters are applied to newly seen jobs only; changed preferences do not re-filter existing jobs yet. `SHORTLISTED`/`SKIPPED` need a score first (Phase 4).

## Phase 4 — Matching ☑

Deterministic prefilter; requirement extraction (structured, versioned prompt); `AIProvider` + fake providers; per-dimension scoring with evidence and deterministic aggregation; cost guard; score UI; regression fixtures.

- **Done (2026-10-29):** 346 tests green; build green; UI smoke run (score queued from the inbox, worker scored, sort by score, breakdown on the job page, re-score after a fix; no console errors).
  - Domain matching (ADR-024): requirement list with stable keys from the posting's listed sections; lexical evidence with aliases, short "or" alternatives, and a years-of-experience cap; nine scored dimensions with rationales and explicit `unknown` flags; "strong" requires requirement evidence; sponsorship only from your explicit saved answer; sensitive facts never used.
  - Model step behind a `MatchAnalyzer` port: `match-analysis` v1 prompt, Zod output with one repair, citations validated against the facts actually supplied, judgments merged by `mergeModelJudgments`; model text shown separately and never used for the score.
  - Cost guard (ADR-025): budgeted provider wrapper charges turns, input size, and cost to `RunBudget`; any limit or provider failure falls back to deterministic scoring with the reason recorded; provider runs persisted.
  - Worker `score_job` tasks, auto-queued after discovery (capped by `MAX_JOBS_SCORED_PER_RUN`, keyed by content hash); stale-score detection; API scoring endpoints and score sorting; inbox badges and job-page breakdown.
  - Regression fixtures `fixtures/ai/match-cases.json`: valid judgments, injection obeyed by the model, hallucinated ids, repaired output, fail-closed output.
- **Not done / deferred:** no real provider is wired yet (Phase 9), so runtime scoring is deterministic. Model-based _requirement extraction_ from unstructured descriptions is not implemented; postings without recognizable requirement sections score requirement dimensions as unknown. Match weights are the defaults (no UI to change them). Re-scoring after preference changes is manual (the stale badge shows when).

## Phase 5 — Résumé tailoring ☑

Candidate fact selection; tailoring prompt with fact-ID-only output; deterministic no-drift validator (numbers, dates, proper nouns, tools, credentials, scale, chronology); integrity review via provider; regenerate-once/drop; HTML→PDF/DOCX rendering + verification; immutable artifacts + diff UI.

- **Done (2026-10-30):** 374 tests green; build green; UI smoke run on a throwaway DB (tailor from the job page → worker rendered with headless Chrome → review page with provenance and checks → PDF downloaded as an attachment with an extractable text layer → approved; no console errors).
  - Domain: `TailoredResume` schema; `groupByRole` (achievements belong to the role they were listed under in the imported résumé, never guessed); `selectFacts` (relevance + match citations, one-page/full caps, role order preserved); `validateBullet` no-drift validator (ADR-026); `wordDiff`; `TailoringService` (generate → validate → independent review → one revision → drop with reason; verbatim facts without a generator; one-page fitting by removing bullets).
  - AI: versioned prompts `resume-tailoring` v1, `resume-revision` v1, `integrity-review` v1 and budgeted generator/reviewer factories.
  - Documents: accessible single-column HTML template, tagged PDF via Playwright (bundled Chromium, system Chrome fallback), DOCX via `docx`, verification of text layer, reading order, links, glyphs, overflow, DOCX text, and page count.
  - DB: migrations 0005–0006 (artifact links on `resume_versions`, status trigger, immutability triggers for versions and bullets, `classic` template row); `ResumeVersionRepository`.
  - Worker `tailor_resume` task; API for tailoring, detail with provenance and diffs, approve/reject, and attachment-only artifact downloads; UI résumé panel and review page.
- **Not done / deferred:** no real generator or reviewer until Phase 9, so résumés currently use facts verbatim. The validator is intentionally strict (e.g. "forty" vs "40" is flagged rather than normalized); tune with real model output in Phase 9. Only one template. Facts confirmed without résumé provenance appear under "Selected highlights" instead of under an employer.

## Phase 6 — Application drafting ☑

Cover letter and free-text answers with provenance labels; saved-answer lookup; deterministic sensitivity classifier; consistency review; pending-question workflow.

- **Done (2026-10-30):** 432 tests green; build green; UI smoke run on a throwaway DB (start application from a job → select approved résumé → draft and approve a cover letter → add common questions → answer a sensitive question; state walked DRAFT → … → AWAITING_USER_INPUT; audit metadata contains no answer values; no console errors).
  - Domain: `classifyQuestion` (32 categories, restrictive first; ADR-028); `planAnswer` (fills only explicitly shared profile data, links, approved files, and saved answers; sensitive and protected questions only from exact saved answers or explicit defaults, always for review; prohibited fields never get a value; values must match options); `validateMotivation`; `checkConsistency`; `ApplicationService` (materials, questions, owner answers, re-planning, cover letters, AI answer drafts, state walk up to `AWAITING_USER_INPUT`/`PREPARING`).
  - Cover letters (ADR-029): sentences labelled fact / motivation / courtesy; fact sentences pass the résumé validator, motivation sentences pass the motivation validator; one revision, then drop; verbatim facts without a model; rendered to PDF/DOCX with checks; immutable versions with one approve/reject decision.
  - AI: `cover-letter` v1, `application-answers` v1, `segment-revision` v1 prompts and `createApplicationDrafter`.
  - DB: migrations 0007–0008 (material links on applications, field category/origin, answer notes, `cover_letter_versions`, triggers: cover letters immutable, fields immutable, needs_review answers finalized only by the owner).
  - Worker `draft_cover_letter` task; API for applications, questions, answers, cover letters, drafts; downloads extended to cover letters; UI Applications list and workspace.
  - Fixed along the way: classifier prefix patterns ("relocat", "disabilit", "graduat") never matched; optional sensitive questions blocked completeness; the motivation word list was not normalized like the text it is compared with ("focus" → "focu"); a deprecated Fastify option.
- **Not done / deferred:** questions come from the common set or manual entry until Phase 7 reads them from the form. No real drafter or reviewer until Phase 9 (letters use facts verbatim; free-text answers are written by the owner). No independent model consistency review yet (deterministic only). Demographic defaults have no settings UI yet. `READY_FOR_REVIEW` is reached in Phase 7 after the form is prefilled.

## Phase 7 — Browser preparation ☑

Playwright headed driver; isolated contexts; route allowlist; snapshots + redaction + handle invalidation; 12-tool surface; Greenhouse/Lever/Ashby fixture adapters; auth/CAPTCHA handoff; no-submit-by-construction tests; all browser fixtures from spec §23.

- **Done (2026-10-30):** 452 unit/integration tests and 10 browser tests green; build green. Browser tests drive headless Chromium against local fictional forms only. UI check of the new form panel on a throwaway DB; the button was not used against the smoke job because its URL is a real ATS host.
  - `packages/browser`:
    - `BrowserSession`: one context per application or a per-origin persistent profile; network guard installed before the first page load; popups closed, downloads cancelled, dialogs dismissed; hard lifetime.
    - Route guard (ADR-031): http(s) only; top-level navigation only to the application's origin; private networks blocked; every non-GET request blocked while preparing; fails closed on errors.
    - Snapshots: main frame, same-origin iframes and open shadow roots; handles held on the Node side and tied to a generation; secrets redacted.
    - `classifyControl`: anything that could send, agree, or finalize counts as submit.
    - `BrowserToolbox`: exactly the 12 tools. Values come only from the owner's finalized answers and approved files; consent, prohibited, secret, and unrecognized controls are refused.
    - Greenhouse/Lever/Ashby/generic adapters (read-only).
    - Deterministic `prepareForm` driver (ADR-032).
  - Fixtures: `fixtures/ats-forms` (Greenhouse-, Lever-, Ashby-like forms; login; CAPTCHA; confirmation) and `startFormFixtureServer` in testkit, which records any write it receives. Every browser test asserts that none arrived.
  - Domain: `ApplicationService.syncPageFields` (form questions become `page` questions; a hand-added question with the same wording is replaced and its answer kept if it still fits; unlabelled questions always wait for the owner), `markReadyForReview` (form read, materials ready, required answers complete, no empty required fields or errors on the form), and reopening review when the owner changes anything.
  - DB migration 0009 (browser session adapter, hand-off message, steps, last URL without query; status and finality triggers); `BrowserSessionRepository`.
  - Worker `prepare_application` / `close_browser` tasks with `BrowserPreparer` (keeps the window open across hand-offs); API `POST /applications/:id/browser/prepare|close` and browser state on the detail endpoint; UI "Fill the application form" panel with Continue and Close.
  - `pnpm test:browser` (ADR-030).
- **Not done / deferred:** no model drives the toolbox yet (Phase 9); preparation is deterministic. Because every write is blocked while preparing, forms that upload files or autosave through background requests may show errors; the owner then attaches or saves those parts in the window. Adapter submit-endpoint patterns and `submitControl`/`isConfirmation` exist for Phase 8 but are not verified against live sites. Only same-origin iframes are filled. Questions are synced per visible step, so later steps' questions appear only after Continue.

## Phase 8 — Approval and submission ☑

Review UI; binding hashes; token issue/consume/revoke; SubmissionService; confirmation predicates; uncertain handling; full replay/mutation matrix (APPROVAL_MODEL §5).

- **Done (2026-10-30):** unit/integration suite and build green; 21 browser tests green, 11 of them the APPROVAL_MODEL §5 matrix against the local fixture form (each checks how many writes reached the fixture server).
  - `packages/security/approval`: `ApprovalService` (issue / verify / atomic consume + `SUBMITTING` + attempt row in one transaction / revoke), HMAC with `HKDF(LOCAL_SESSION_SECRET, "approval-v1")`, token stored as SHA-256 only, `answerSetHash`, `buildBindingMaterial` (one builder for the API and the worker), token transport sealed for the worker task.
  - `@career-agent/browser/submission` (ADR-033): `SubmissionService` (verify → re-snapshot → recompute binding → consume → open the one-shot write gate for the bound origin → click the bound control once → classify) and the write gate. Writes during the gate are sent once by Playwright with no retries or automatic redirects; repeats are blocked.
  - Worker: review snapshots (form hash, the single submit control, a checklist that includes "changed on the page" checks and unticked owner-only boxes); `refresh_review` and `submit_application` tasks (never retried); approvals left active by a previous worker are revoked at startup.
  - Domain: `SUBMITTING → READY_FOR_REVIEW` only for a form the site rejected before anything was sent (ADR-034); owner edits revoke an active approval and are refused once submission has started; `submissionMaterials` re-verifies approved files against their hashes.
  - DB migration 0010: `submission_attempts` (one per approval, only for a consumed approval, append-only once finished) and `browser_sessions.review`.
  - API: refresh review, approve (`{confirm: true}`; checks state, answers, materials, a live reviewed form with an empty checklist that is no older than the approval TTL, one submit control, the origin; then issues and queues), revoke, resolve an uncertain submission (owner only). UI: "Review and approve" with an explicit confirmation, progress, outcome evidence, and the uncertain-resolution buttons.
  - `OPERATING_MODE` setting (default `review-each`); other modes cannot issue approvals or submit.
- **Not done / deferred:** The approve endpoint's success path is tested through the same builder in the worker browser tests, not through HTTP. The review UI has not been checked in the running app. Confirmation predicates are text-based and only verified against fixtures. Forms that send their submission to another origin, or as several requests to the same endpoint, end as `SUBMISSION_UNCERTAIN`.

## Phase 9 — Hybrid orchestration ☑

OpenAI Agents SDK orchestrator; Claude Agent SDK provider (ADR-008 options re-verified); `delegate_to_claude`; router with bounded retry/fallback; provider health; usage/cost UI. Live smoke tests only with explicit owner authorization.

- **Done (2026-10-30):** 475 unit and integration tests and 21 browser tests green; build green; the new AI & usage page checked in the running app (API and web only, so no provider was called). No paid or live model call was made: tests drive the real Agents SDK loop through its `Model` interface with scripted responses, and the Claude SDK through an injected `query` function.
  - SDKs (pinned): `@openai/agents-core` / `@openai/agents-openai` 0.21.0, `@anthropic-ai/claude-agent-sdk` 0.3.312 (ADR-008/009 option names re-checked against the installed `.d.ts`).
  - `OpenAIAgentsProvider`: structured output through an `Agent` with a JSON-schema output type; tracing export disabled; model id only from `OPENAI_MODEL`; usage from the run context; cost from optional `OPENAI_INPUT/OUTPUT_USD_PER_MTOK`; SDK and HTTP errors mapped to provider errors.
  - `ClaudeAgentProvider`: ADR-008 lockdown (`tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, `persistSession: false`, no MCP servers, own `systemPrompt`, minimal env without secrets, bounded turns and budget); reads `structured_output`; maps sign-in, plan-limit, turn, and budget failures.
  - `ProviderRouter` (ADR-035): modes, per-provider retries (rate limit, timeout, unavailable) with capped jittered backoff, fallback without cycles, no fallback for refusals or invalid output or in single-provider modes, circuit breaker, health report, and a `provider_runs` row for every failed attempt.
  - `orchestrate` (ADR-036): OpenAI agent with only the tools passed in plus `delegate_to_claude` (capped by `MAX_CLAUDE_DELEGATIONS_PER_RUN`), all under one run budget; prompts `form-preparation` v1 and `delegation` v1.
  - Wiring: worker uses the router for match analysis, résumé generation, the integrity reviewer (Claude first in hybrid), and drafting; the API uses it for answer drafting and résumé fact extraction (recorded in `provider_runs`). Opt-in `BROWSER_MODEL_ASSIST` runs one orchestrated pass with the 12 answer-bound browser tools when the rule-based pass stops; a fresh rule-based pass then decides the outcome.
  - API `GET /api/v1/system/providers` and `/system/usage`; UI "AI & usage" page.
- **Not done / deferred:** "compare" mode routes like "hybrid" (no side-by-side runs yet). No live smoke test was run (needs your explicit authorization, `ENABLE_LIVE_AI_TESTS=true`, an API key, and a Claude Code login). Claude sign-in is checked on first use, not by the health report. Model-assisted preparation has been tested with scripted models only, never against a real form or model. Per-day usage history and a monthly budget cap are not built.

## Phase 10 — Hardening and release ☐

Full E2E suite; accessibility pass; dependency and secret audit; backup/restore test; README/USER_GUIDE/OPERATIONS complete; release-check skill run; fictional demo mode.

## Cross-cutting rules

- Schema changes only via migrations.
- New consequential behavior → audit event + test.
- Any change touching approval/submission/browser tools → update THREAT_MODEL and run the `security-reviewer` subagent.
