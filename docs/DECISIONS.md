# Architecture Decision Records

Each entry: context → decision → consequences. Status is `accepted` unless stated. Dates are UTC.

---

## ADR-001 — TypeScript monorepo with pnpm workspaces (pnpm 10)

- **Date:** 2026-10-29
- **Context:** The spec requires a pnpm TypeScript monorepo. The current `latest` pnpm is 12.x; pnpm 10.x is still maintained (`latest-10` = 10.34.9) and its security defaults (dependency lifecycle scripts blocked unless allow-listed via `onlyBuiltDependencies`) are well understood.
- **Decision:** Pin `packageManager: pnpm@10.34.9`. Allow-list native builds explicitly (`better-sqlite3`, `esbuild`).
- **Consequences:** Reproducible installs; upgrading to pnpm 12 is a later, explicit ADR after reviewing its changelog.

## ADR-002 — Node.js runtime

- **Context:** Spec targets Node 22 LTS. The development machine runs Node 26.3.1 (no version manager installed). As of 2026-10, Node 22 is in maintenance LTS and Node 24 is active LTS.
- **Decision:** `engines.node: ">=22.12"`; `.nvmrc` = `22`. CI runs Node 22 and 24. Code uses only APIs available in Node 22.
- **Consequences:** Local runs on 26 may surface native-module issues earlier than CI; these are treated as bugs.

## ADR-003 — TypeScript 6.0.x, not 7.x

- **Context:** `typescript@latest` is 7.0.2 (native compiler). `typescript-eslint@8.72.1` declares peer `typescript >=4.8.4 <6.1.0`.
- **Decision:** Pin `typescript@~6.0.3`. Revisit when `typescript-eslint` supports 7.x.
- **Consequences:** Type-aware linting works; slower compiler than 7.x.

## ADR-004 — SQLite (better-sqlite3) + Drizzle behind repository interfaces

- **Context:** Single-user local MVP; PostgreSQL later must stay possible.
- **Decision:** Drizzle ORM with `better-sqlite3` (synchronous, transactional, WAL mode). Domain code depends only on repository interfaces in `packages/domain`; Drizzle lives in `packages/db`. If `better-sqlite3` fails to build on a supported Node version, fall back to `node:sqlite` via a thin adapter (decided in Phase 1 with evidence).
- **Consequences:** Atomic single-use token consumption is a single `UPDATE … WHERE consumed_at IS NULL` in a transaction.
- **Evidence (Phase 1):** `better-sqlite3@13.0.3` compiles and runs on Node 26.3.1 (SQLite 3.53.4); the `node:sqlite` fallback is not needed. All repository writes use `BEGIN IMMEDIATE` transactions.

## ADR-005 — Field-level encryption (AES-256-GCM)

- **Context:** Sensitive columns (contact data, saved sensitive answers, demographic defaults, compensation) must be encrypted at rest. SQLCipher adds native-build complexity.
- **Decision:** Application-level AES-256-GCM via `node:crypto` with a 32-byte data key. Key source order: OS keychain (macOS `security`, behind an interface) → `DATA_ENCRYPTION_KEY` env (base64, validated). Ciphertext format `v1:<keyId>:<iv>:<tag>:<ct>` for rotation. Encrypted columns are never indexed; lookups use HMAC blind indexes where needed.
- **Consequences:** Non-sensitive metadata (states, timestamps, hashes) remains queryable. Losing the key loses sensitive data; export/backup docs must say so.

## ADR-006 — Approval tokens: opaque + HMAC + DB-authoritative

- **Context:** Tokens must be short-lived, single-use, bound to application/owner/URL/origin/job/snapshot/answers/artifacts/submit control, and replay-safe.
- **Decision:** Token = `approvalId.random(32B)`; DB stores `approvalId`, SHA-256 of the secret part, the canonical binding JSON, its HMAC-SHA256 (keyed by `LOCAL_SESSION_SECRET`-derived key), `issued_at`, `expires_at`, `consumed_at`, `revoked_at`. Validation: constant-time hash compare → binding recomputed from live state and compared → atomic consume (`UPDATE … SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, require 1 row changed). JWTs are not used: revocation and single-use require DB state anyway.
- **Consequences:** A stolen DB alone cannot mint tokens without the session secret; a stolen token is useless after TTL (default 300 s) or after consumption.

## ADR-007 — Submission is not reachable from model tools (by construction)

- **Decision:** `SubmissionService` lives in `packages/browser/src/submission/` and is exported only via the `@career-agent/browser/submission` subpath. `packages/ai` is forbidden (ESLint `no-restricted-imports` + a dependency test) from importing it. The model tool registry is a frozen allowlist of the 12 tool names in spec §13; a test asserts set-equality and that no tool name/description matches `/submit|apply|send|confirm/i` except `ready_for_review`. `click_safe_control` refuses any element classified as a submit control.
- **Consequences:** Adding a submit-capable tool requires changing a test that names this ADR.

## ADR-008 — Claude Agent SDK in subscription mode, locked down

- **Context:** Verified in `@anthropic-ai/claude-agent-sdk@0.3.312` types: `query({prompt, options})`; options include `tools`, `allowedTools`, `disallowedTools`, `permissionMode` (`'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`), `maxTurns`, `maxBudgetUsd`, `cwd`, `settingSources` (`'user'|'project'|'local'`), `outputFormat` (`json_schema`), `abortController`, `env` (which **replaces** the subprocess environment entirely).
- **Decision:** `tools: []` (no built-in tools; review is pure reasoning over supplied JSON), `permissionMode: 'dontAsk'`, `disallowedTools: ['Bash','Write','Edit','NotebookEdit','WebFetch','WebSearch']` as defence in depth, `settingSources: []`, `cwd: CLAUDE_WORKING_DIRECTORY` (empty dedicated dir), `maxTurns`, `maxBudgetUsd`, `outputFormat` JSON schema derived from Zod, and an explicit minimal `env` (PATH, HOME, locale) that excludes `OPENAI_API_KEY`, `DATA_ENCRYPTION_KEY`, `LOCAL_SESSION_SECRET`. Never `bypassPermissions`.
- **Consequences:** Claude cannot read files, run commands, or see other credentials. Exact option names are re-verified against installed types in Phase 9.
- **Evidence (Phase 9, `0.3.312` installed):** all options above exist with these names. Also used: `persistSession: false` (no session files), `strictMcpConfig: true` with `mcpServers: {}`, and `systemPrompt` as a plain string, which replaces the Claude Code preset. Results come from `SDKResultMessage`: `structured_output`, `total_cost_usd` (an estimate), `modelUsage`, and `api_error_status`. Sign-in problems arrive as `auth_status` messages with `error`. `0.3.314` (published the same day) was not adopted.

## ADR-009 — OpenAI Agents SDK as orchestrator

- **Context:** Verified `@openai/agents@0.21.0` exists; `@openai/agents-core` exposes function tools with `needsApproval` and `Runner` `maxTurns`.
- **Decision:** Use function tools wrapping our restricted browser surface and `delegate_to_claude`. Model id comes only from `OPENAI_MODEL`. If OpenAI is enabled but `OPENAI_API_KEY` or `OPENAI_MODEL` is empty, config marks OpenAI _unavailable_ with an actionable reason (local/read-only features still start, per spec §30); the provider factory refuses to run it. `needsApproval` is used for `ask_user`/auth handoff flows, never as the submission control (submission is not a tool at all, ADR-007).
- **Consequences:** OpenAI-specific code is isolated in `packages/ai/src/providers/openai.ts`.
- **Evidence (Phase 9, `@openai/agents-core`/`@openai/agents-openai` 0.21.0 installed; the `@openai/agents` umbrella was not used, to avoid the realtime package):**
  - `new Runner({ modelProvider, tracingDisabled, traceIncludeSensitiveData })` and `runner.run(agent, input, { maxTurns, signal })`.
  - `Agent` takes `outputType` as `{ type: "json_schema", name, strict, schema }`; `RunResult` exposes `finalOutput`, `runContext.usage`, `lastResponseId`, and `newItems`.
  - `tool({ name, description, parameters, strict: false, execute, errorFunction })`.
  - `OpenAIProvider({ apiKey })`.
  - Tracing export is disabled because prompts contain the owner's facts.

## ADR-010 — Job sources: public ATS APIs only in MVP

- **Decision:** Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co`), Ashby (`api.ashbyhq.com/posting-api`) public job-board APIs; manual URL import; opt-in read-only generic career-page reader; Workable behind `ENABLE_WORKABLE` after terms review. **No LinkedIn/Indeed**: their terms prohibit automated scraping, data sits behind authentication and anti-bot controls, and evading those conflicts with non-goals in spec §3.
- **Consequences:** Coverage is limited to companies using supported ATSs or manually imported URLs.
- **Evidence (Phase 3, docs checked 2026-10-29):** Greenhouse `content` is entity-encoded HTML and `pay_input_ranges`/`first_published` appear only on the single-job endpoint. Lever documents `workplaceType`, `salaryRange`, `lists`, and an EU instance (`api.eu.lever.co`) but not `createdAt` (treated as optional). Ashby documents no job `id` (derived from `jobUrl`), and the docs are ambiguous about where `compensation` sits (job level is read; anything else is ignored). None of the three documents GET rate limits, so requests are paced at one per second per origin.

## ADR-011 — Defer framework dependencies to the phase that uses them

- **Decision:** Phase 0 scaffolds `apps/web`, `apps/api`, `apps/worker` as typed workspace packages without Next.js/Fastify/Playwright installed. Each is added in the first phase that exercises it (API/DB in Phase 1–2, web in Phase 2, Playwright in Phase 7) with versions re-verified then.
- **Consequences:** `pnpm check` stays green and fast during design; no unused dependency surface.

## ADR-012 — Resumable worker without Redis

- **Decision:** A `tasks` table (added in Phase 1 alongside `agent_runs`) with lease columns (`lease_owner`, `lease_expires_at`, `attempts`, `idempotency_key UNIQUE`). Workers claim via a transactional update. Ambiguous-submission tasks are never re-leased automatically.
- **Consequences:** Single-process throughput is sufficient for one user.

## ADR-013 — Claude Code hooks: one tested PreToolUse guard; no Stop/PostToolUse hooks

- **Context:** Spec suggests hooks for blocking writes to secrets/private data, blocking destructive shell, post-edit diagnostics, and a completion reminder. Verified hook format: `hooks.PreToolUse[].matcher` + `{type:"command", command}`; exit code 2 blocks with stderr as reason.
- **Decision:** Implement `.claude/hooks/guard.mjs` (Node, no `jq` dependency, no network) covering Write/Edit/NotebookEdit on `.env*`/`data/`/`artifacts/`/browser profiles, and Bash commands that are broadly destructive or print the environment. It has unit tests in `scripts/__tests__`. A Stop-hook reminder is **not** added: a blocking Stop hook can loop, and a non-blocking one adds noise; `CLAUDE.md` carries the "run `pnpm check`" rule. Post-edit typecheck is omitted for latency; `pnpm check` covers it.
- **Consequences:** Real enforcement for the highest-risk cases; reminders stay advisory.

## ADR-014 — Subagent concurrency cap is advisory (documented mismatch)

- **Context:** Spec §29 asks settings to cap subagent depth/concurrency. The Claude Code settings index (checked 2026-10-29) has no key for subagent concurrency or nesting depth.
- **Decision:** Enforce via `CLAUDE.md` instruction ("maximum two concurrently"), project subagents declare read-only `tools` and `permissionMode: plan`, and `maxTurns` bounds each. Recorded here per working protocol §1.10.
- **Consequences:** Cap relies on instruction-following; the read-only tool lists limit blast radius.

## ADR-015 — Sortable IDs (UUIDv7)

- **Decision:** UUIDv7 generated in `packages/domain` from `crypto.getRandomValues` + millisecond timestamp, with tests for ordering and format. Canonical job IDs are `source:externalId`.

## ADR-016 — Document parsing and rendering

- **Status:** accepted (parsing Phase 2, rendering Phase 5).
- **Rendering evidence (Phase 5):** `docx@9.15.0` generates headings, bullet lists, and hyperlinks; Playwright `1.64.1` prints tagged PDFs. Its bundled Chromium (revision 1248) was not installed on the development machine, so `launchPrintBrowser` falls back to the system Chrome (`channel: "chrome"`), headless with a temporary profile. CI installs the bundled Chromium.
- **Evidence:** `unpdf@2.0.0` bundles a serverless pdf.js build with no `new Function`, so font programs are never evaluated (no `isEvalSupported` option exists or is needed). `mammoth@1.13.0` ships its own types. Both parse the generated PDF/DOCX fixtures in tests.
- **Decision:** PDF text via `unpdf` (pdf.js-based, 2.0.0), DOCX via `mammoth` (1.13.0). Résumé rendering: HTML/CSS template → PDF through Playwright Chromium `page.pdf()`; DOCX output library chosen in Phase 5 after evaluation. Uploads limited by MIME sniffing + size + page count; zip-bomb guard on DOCX (entry count and uncompressed-size limits).

## ADR-017 — Workspace packages export built output; tests alias to source

- **Date:** 2026-10-29
- **Context:** TypeScript project references (`composite`) reject importing another project's `.ts` sources (TS6307), but tests should not require a build first.
- **Decision:** Each package exports `dist/index.{js,d.ts}`; `tsc -b` builds in reference order (`pnpm typecheck` = `pnpm build` = `tsc -b`). Vitest aliases `@career-agent/<pkg>` to `packages/<pkg>/src/index.ts`. Test files are compiled too (so they are typechecked and linted).
- **Consequences:** Apps run from `dist`. Subpath exports (e.g. `@career-agent/browser/submission`, ADR-007) must be added to both `exports` and the Vitest alias.

## ADR-018 — Encryption granularity and AAD binding

- **Date:** 2026-10-29
- **Decision:** Ciphertext AAD is `<table>.<column>:<rowId>`, so a value copied to another row or column fails to decrypt. Saved answers, application answer values, and profile data are always encrypted. Facts are encrypted only when `sensitive = true` (claim and evidence). Non-sensitive facts stay plaintext so that the deterministic provenance validator can work without the key. Writing sensitive data without a key fails closed with `PolicyError`.
- **Consequences:** Disclosure of non-sensitive facts (e.g. "Wrote TypeScript services") from a stolen DB is accepted residual risk. Key rotation is supported by key IDs (`needsRotation`); the re-encryption job is a later operations task.

## ADR-019 — Local API session, CSRF, and idempotency

- **Date:** 2026-10-29
- **Context:** The API listens on loopback, but any web page in the owner's browser can send requests to `127.0.0.1` (CSRF, DNS rebinding).
- **Decision:** (1) Reject non-loopback peers and any `Host` header outside `{127.0.0.1, localhost, [::1]} × {API_PORT, WEB_PORT}`. (2) `GET /api/v1/session` sets an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie (12 h) and returns a CSRF token = HMAC(session); keys are HKDF-derived from `LOCAL_SESSION_SECRET`. (3) Mutations require the CSRF header, an allowed `Origin` when present, and `Sec-Fetch-Site` of `same-origin`/`none` when present. No CORS headers are ever sent. (4) Mutations require `Idempotency-Key`; responses are stored encrypted per (key, route) and replayed; reuse with a different body is a 409. (5) The browser only talks to the Next.js origin, which proxies `/api/v1/*` to the API.
- **Consequences:** Other local processes running as the same OS user are trusted (out of scope, THREAT_MODEL residual risk 4). Two concurrent first-time requests with the same key can both execute; services are individually conflict-safe (candidate decisions are single-use).

## ADR-020 — Next.js app outside the `tsc -b` graph

- **Date:** 2026-10-29
- **Decision:** `apps/web` uses Next's own tsconfig (`moduleResolution: bundler`, `noEmit`) and is typechecked with `next typegen && tsc --noEmit` and built with `next build`; root `typecheck`/`build` run both. The UI talks to the API only over HTTP and declares its own response types. Next.js telemetry is disabled in all web scripts. API rewrites are resolved at build time, so `next start` proxies to the `API_PORT` set when the web app was built.
- **Consequences:** Domain types are duplicated as UI response shapes. API contract tests cover the server side; UI E2E arrives in Phase 7.

## ADR-021 — Application services in the domain package, behind ports

- **Date:** 2026-10-29
- **Decision:** Use-case services (`FactBankService`, `ProfileService`) live in `packages/domain/src/services` and depend only on repository interfaces, a `UnitOfWork`, and function ports (`DocumentPorts`). Route handlers only validate input and call services. The SQLite store implements `UnitOfWork` with better-sqlite3 transactions; repository transactions nest as savepoints (verified by test).
- **Consequences:** Multi-repository writes (e.g. confirm fact + decide candidate + audit) are atomic and testable without HTTP.

## ADR-022 — `packages/sources` for discovery; no Workable adapter yet

- **Date:** 2026-10-29
- **Context:** The spec's package list has no home for source adapters; `documents` and `browser` are the wrong layers.
- **Decision:** Add `packages/sources` (adapters, normalization, HTML handling, paced HTTP, URL import), depending only on `domain` and `security`. The domain's `DiscoveryService` talks to it through `DiscoveryPorts`. Workable is not implemented: its public API terms and limits have not been reviewed, so `ENABLE_WORKABLE=true` still yields a clear "not supported" error. The generic reader accepts only schema.org `JobPosting` JSON-LD and needs explicit opt-in per import; pages without structured data are rejected rather than scraped heuristically.
- **Consequences:** Adding an ATS means one adapter, its fixtures, and contract tests.

## ADR-023 — SSRF-safe HTTP client with DNS pinning

- **Date:** 2026-10-29
- **Decision:** All outbound source HTTP goes through `safeFetch` (node `http`/`https`). It applies `checkUrl` to every URL and redirect hop, resolves DNS inside the socket's `lookup` hook, requires every resolved address to be public, and connects to the vetted address. Connection pooling is disabled so every request is vetted. It also bounds decompressed size (gzip/br/deflate), total time, redirect count and content type. On top of that, `createSourceHttp` paces requests to one per second per origin and retries only network errors, timeouts, 429 and 5xx (at most 2 retries, capped backoff with jitter, `Retry-After` honored up to 60 s).
- **Consequences:** There is no window between the DNS check and the connection for rebinding attacks. Not reusing connections costs a little performance, which is fine for one user.

## ADR-024 — Matching: deterministic score, model as a checked advisor

- **Date:** 2026-10-29
- **Decision:** The total and verdict are always computed by `scoreMatch` in the domain from requirement assessments, facts, and preferences. A model (when configured) may only judge per-requirement status with citations. `mergeModelJudgments` drops unknown keys and citations to facts the model was not shown, downgrades uncited "met"/"partial" to "unknown", and caps years-of-experience requirements at "partial". Missing information scores a neutral 50 marked `unknown` and is listed for the owner. "Strong" additionally requires requirement coverage that is known and at least 60. Sponsorship is judged only from the owner's explicit saved answer. Sensitive facts are excluded from matching and prompts.
- **Consequences:** Scores are explainable and reproducible, and the model cannot raise a score without real evidence. Lexical matching misses paraphrases (e.g. "built REST services" vs "API design"); the model step is meant to cover those, with citations.

## ADR-025 — Cost guard for model calls

- **Date:** 2026-10-29
- **Decision:** Every model call goes through `budgeted(provider, RunBudget)`, which charges a turn, checks the rendered input size, adds the reported cost, and aborts on any limit (default per job: 2 turns, 40k chars, 120 s, $0.25). Scoring tasks per discovery run are capped by `MAX_JOBS_SCORED_PER_RUN`. When the budget or provider fails, the job is still scored deterministically and `meta.modelSkippedReason` says why. Every call is recorded in `provider_runs` (usage, cost, prompt id/version, trace id).
- **Consequences:** A runaway prompt or provider can at most cost one job's budget. Providers that report no cost are bounded by turns and input size. Phase 9: OpenAI costs are computed only when `OPENAI_INPUT_USD_PER_MTOK`/`OPENAI_OUTPUT_USD_PER_MTOK` are set (no built-in price list that could go stale). Claude reports the SDK's estimate.

## ADR-026 — Résumé tailoring: strict no-drift validator, revise once, then drop

- **Date:** 2026-10-30
- **Decision:** Every generated line must pass `validateBullet` before it can appear. It requires that every cited fact exists, permits the transformation used, and belongs to the entry the line is placed under. It also requires that every number, name, tool, credential and other content word is in the cited facts, apart from a short list of neutral verbs. Leadership and cause-and-effect wording must be stated in the facts too. "select"/"reorder" must be verbatim. Lines that pass go to the independent reviewer when one is configured. A line failing either gets one revision through `resume-revision` v1, then is dropped with its reason. Role headings, education, skills, and other lists are always verbatim fact text. Without a generator, achievements are used verbatim, ordered by relevance.
- **Consequences:** False positives (a harmless word the facts do not contain) cost a line, never truthfulness. The neutral-word list is the tuning point; changing it requires the validator tests to keep failing on every drift case.

## ADR-027 — Immutable résumé versions and artifact downloads

- **Date:** 2026-10-30
- **Context:** drizzle-kit generated a table rebuild to add a CHECK constraint to `resume_versions`. The rebuild copied columns that did not exist yet, so it would fail on existing databases, and it dropped a table that other rows reference.
- **Decision:** Migration 0005 only adds columns; valid statuses and immutability are enforced by triggers (0006). A version may change only once, from `draft` to `approved`/`rejected`; `needs_attention` (a failed render check) cannot be approved; bullets cannot change or be deleted. Downloads serve only rendered résumé artifacts (`resume_pdf`, `resume_docx`, `resume_html`), always as attachments with generated names, after re-verifying the file's SHA-256.
- **Consequences:** Generated migrations that rebuild tables must be reviewed by hand before use. A new edit always creates a new version.

## ADR-028 — Application questions: deterministic classification and conservative answer planning

- **Date:** 2026-10-30
- **Decision:** `classifyQuestion` maps each question to one of 32 categories by keyword rules ordered most-restrictive first (CAPTCHA, signature, government ID, legal attestation, consent/terms, demographic, date of birth, criminal, conflict, non-compete, sponsorship, authorization, compensation, availability, relocation, travel, referral …). Unknown questions and unknown checkboxes require the owner. Prohibited categories (CAPTCHA, signature, government ID, attestation, consent) are never filled; the owner completes them in the form. `planAnswer` fills automatically only from data the owner explicitly provided: profile fields shared "always", links, approved files, and saved answers to non-sensitive questions. Sensitive or protected questions get proposals only from an exact saved answer or the owner's explicit demographic default, and always need the owner's confirmation; similar saved answers are suggestions only. Choice answers must match an option exactly. Optional questions may stay blank.
- **Consequences:** Misclassification errs toward asking the owner. A model can later suggest categories but cannot relax these rules.

## ADR-029 — Cover letters as labelled, verified segments

- **Date:** 2026-10-30
- **Decision:** A letter is greeting + paragraphs of segments + closing + signature. Greeting, the opening "I am applying for …" line, closing, and signature are fixed templates. "Fact" segments cite facts and pass `validateBullet`. "Motivation" segments pass `validateMotivation`: posting-derived wording only, no new numbers or names, and no personal history, product use, referrals, conversations, "passion", or claims of fit. A failing segment gets one revision, then is dropped and listed. Without a model, the letter states the most relevant achievements verbatim and tells the owner to add their own reasons. The UI labels every sentence by kind.
- **Consequences:** Model-written letters are plainer than typical ones. That is intended: enthusiasm and reasons for applying must come from the owner.

## ADR-030 — Browser tests: Vitest + Playwright library against local fixture forms

- **Date:** 2026-10-30
- **Decision:** `pnpm test:browser` runs Vitest with `vitest.browser.config.ts` over `*.browser.test.ts`, which the default suite excludes. Tests drive headless Chromium through the Playwright library; when Playwright's own Chromium is missing they fall back to the installed Chrome. They use the fictional forms in `fixtures/ats-forms`, served by `startFormFixtureServer` on 127.0.0.1 (or `*.localhost`). The server records every non-GET request. Playwright Test was not adopted: the same Vitest aliases, helpers, and real `Store` can be shared with the unit suite.
- **Consequences:** No real employer site is ever contacted. The UI itself has no end-to-end browser tests yet; the panel is checked by hand.

## ADR-031 — Preparation browser: answer-bound tools and a write-blocking network guard

- **Date:** 2026-10-30
- **Decision:** No preparation code path (deterministic or model-driven) can submit. Four layers enforce this:
  1. The 12 tools have no submit, script, navigation, free-text or path inputs. Values are referenced by answer id, files by kind.
  2. `classifyControl` marks anything that could send, agree, sign, or finalize as `submit`, and every tool refuses it. Only exact navigation captions (Next, Continue, …) are clickable.
  3. The context's route guard blocks every non-GET request (document or XHR) and every top-level navigation off the application's origin.
  4. The deterministic submission service (Phase 8) will use its own context and lives behind the `@career-agent/browser/submission` subpath; ESLint forbids the toolbox and preparation code from importing it.

  Handles are kept on the Node side, scoped to one snapshot generation, and re-checked against the live element, so a page cannot redirect a tool to another element. Answers for questions read from the form must match that exact question. Fixture adapters are recognized by a page marker only on loopback hosts.

- **Consequences:** Some real forms that upload or autosave in the background will need the owner to finish those parts. That is acceptable; failing open is not.

## ADR-032 — Deterministic preparation, owned by the worker

- **Date:** 2026-10-30
- **Decision:** `prepareForm` runs a fixed loop: inspect → read questions → sync them to the application → fill finalized answers through the toolbox → check readiness → Next. It stops for the owner on a password or CAPTCHA, missing required answers, validation errors, or required fields only the owner completes. The worker keeps the visible window open between passes, so the owner can sign in or answer and press **Continue**. Sessions left open by a previous worker are marked closed at startup. Only a pass that finds the whole form ready moves the application to `READY_FOR_REVIEW`. Changing any answer or material afterwards moves it back to `PREPARING`.
- **Consequences:** Preparation works without any AI provider. In Phase 9 a model may drive the same toolbox, under the same limits.

## ADR-033 — Submission in the prepared window through a one-shot write gate

- **Date:** 2026-10-30
- **Context:** ADR-031 planned a separate context for submission. But the filled form, the owner's ticked boxes, and their sign-in exist only in the prepared window, and the approval binds that exact form.
- **Decision:** Submission reuses the prepared context. Its route guard owns a write gate that starts closed. Only `@career-agent/browser/submission` can reach the gate (a module-level registry); ESLint forbids the toolbox, preparation, and `packages/ai` from importing that path. The service opens the gate only after the token has been consumed, only for the bound origin, and only around the single click.

  While the gate is open, each write is sent once by Playwright itself (`route.fetch`, no retries, no automatic redirects) and handed to the page. A second write to the same endpoint is blocked. This matters because, in testing, Chromium re-sent a POST on its own after a dropped connection.

- **Consequences:** A submission that needs writes to another origin, or several writes to one endpoint, does not complete and ends as `SUBMISSION_UNCERTAIN`. That is preferred over widening the gate.

## ADR-034 — Approval flow: worker review snapshot, approve-and-queue, owner-only resolution

- **Date:** 2026-10-30
- **Decision:**
  - **Review snapshot:** the worker owns the browser, so it takes the review snapshot (form hash, submit control, open checklist). It does so after a "ready" pass and when the owner presses Refresh review.
  - **Approve:** approval is refused unless that snapshot is from a live session, has an empty checklist, and is no older than `APPROVAL_TTL_SECONDS`. The API then builds the binding with the same builder the worker uses before clicking, issues the token, and queues one `submit_application` task.
  - **Token in transit:** the task carries the token sealed with a key derived from `LOCAL_SESSION_SECRET` and bound to the approval id. The database keeps only its hash.
  - **Outcomes:** confirmation text → `SUBMITTED`. A same-page validation error with zero writes sent → back to `READY_FOR_REVIEW` (new guarded edge; nothing reached the employer). Anything else → `SUBMISSION_UNCERTAIN`, which only the owner resolves. Nothing is retried.
- **Consequences:** Approving requires a fresh look at the live form. A worker restart revokes any outstanding approval.

## ADR-035 — Provider router: modes, bounded retry, no-cycle fallback, circuit breaker

- **Date:** 2026-10-30
- **Decision:** `ProviderRouter` implements `AIProvider`, so every existing caller (analyzer, generator, reviewer, drafter, extraction) uses it unchanged.
  - **Modes:** `openai` / `claude` use only that provider and never fall back. `hybrid` sends `integrity_review` to Claude first (an independent reviewer) and everything else to OpenAI first. `auto` tries healthy providers first. `compare` routes like `hybrid` for now.
  - **Retries:** only rate-limit, timeout, and unavailable errors are retried, at most `min(MAX_PROVIDER_RETRIES, limits.maxRetries)` times, with exponential backoff (×0.5–1 jitter, capped at 30 s).
  - **Fallback:** each provider is tried at most once per call. Refusals and invalid output do not fall back, because they are about the request, not the provider.
  - **Circuit breaker:** three consecutive failures pause a provider for 60 s (shown on the usage page).
  - **Records:** every failed attempt writes a `provider_runs` row with its error code; successful calls are recorded by their callers.
- **Consequences:** a provider outage degrades to the other provider or to the rule-based paths that already exist everywhere. Fallback is visible per call (`fallback`) and on the usage page.

## ADR-036 — OpenAI orchestrator with delegate_to_claude; model assist is opt-in and never decides

- **Date:** 2026-10-30
- **Decision:** `orchestrate()` runs an Agents SDK agent whose only tools are the ones its caller passes, plus `delegate_to_claude`.
  - **Delegation:** a locked-down Claude call returning `{answer, concerns}` as advice, capped by `MAX_CLAUDE_DELEGATIONS_PER_RUN`.
  - **Bounds:** every tool call, model turn, and cost is charged to one `RunBudget`. Tool errors reach the model only as short refusal messages.
  - **Form preparation:** under `BROWSER_MODEL_ASSIST=true`, the worker runs one orchestrated pass with the 12 answer-bound browser tools, and only when the rule-based pass stopped or a tool refused something. A fresh rule-based pass then decides the outcome. The model's own "ready" is never trusted.
- **Consequences:** a model can only do what the toolbox already allows (ADR-031). It cannot submit, type free text, or reach the submission subpath. Default preparation stays free and deterministic.
