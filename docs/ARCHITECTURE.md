# Architecture

Career Agent is a local-first, single-owner, human-in-the-loop system. Everything runs on one trusted machine and binds to `127.0.0.1`. Decisions referenced as ADR-NNN live in [DECISIONS.md](DECISIONS.md).

## 1. Component view

```text
            ┌────────────────────────── 127.0.0.1 only ───────────────────────────┐
 Browser ──▶│ apps/web (Next.js UI) ──HTTP+CSRF──▶ apps/api (Fastify /api/v1)       │
 (owner)    │                                         │  enqueue / read             │
            │                                         ▼                             │
            │                         SQLite (WAL, encrypted columns)               │
            │                                         ▲  lease tasks                │
            │                                         │                             │
            │                        apps/worker (resumable task runner)            │
            │        ┌───────────────┬────────────────┼──────────────┬─────────────┐│
            │        ▼               ▼                ▼              ▼             ││
            │  Job source      AI orchestration   Documents      Browser driver   ││
            │  adapters        (packages/ai)      (parse/render) (Playwright,     ││
            │  (HTTP, allow-   OpenAI primary ──▶ delegate_to_   headed, isolated) ││
            │   listed)        Claude reviewer    claude tool    restricted tools ││
            │                                                    + Submission     ││
            │                                                    Service (determ.)││
            └──────────────────────────────────────────────────────────────────────┘
```

- **apps/web** — UI only. No provider keys, no direct DB access. Talks to the API with a local session cookie + CSRF token.
- **apps/api** — Fastify. Zod-validated `/api/v1`, idempotency keys on mutations, loopback-only listener and remote-address check, origin/CSRF checks, rate limits. Thin: routes call application services.
- **apps/worker** — claims tasks from the `tasks` table with leases (ADR-012); runs discovery, scoring, tailoring, drafting and browser preparation. Owns the Playwright process.
- **packages/domain** — Zod schemas (source of truth), entity types, state machines, error taxonomy, repository interfaces, audit-event model. No I/O.
- **packages/db** — Drizzle schema, migrations, repository implementations, transactions, encryption of sensitive columns via `packages/security`.
- **packages/ai** — `AIProvider` interface, OpenAI and Claude providers, router (modes `openai|claude|hybrid|compare|auto`), versioned prompts, structured-output validation with one repair attempt, budget/turn/abort enforcement, error mapping.
- **packages/browser** — Playwright driver, page snapshot + redaction, restricted model tool surface (12 tools), ATS adapters, the deterministic `prepareForm` driver (ADR-031, ADR-032), and — in a separate subpath — the deterministic `SubmissionService` (ADR-007).
- **packages/documents** — résumé import (PDF/DOCX), structured résumé → HTML → PDF/DOCX, artifact hashing, render verification.
- **packages/security** — AES-GCM field encryption, redaction, approval tokens, URL/origin policy, path safety, audit helpers.
- **packages/config** — Zod-validated environment, fail-fast with actionable messages; Claude/OpenAI unavailability degrades features rather than blocking startup.
- **packages/observability** — Pino logger with redaction paths, trace IDs, usage/cost accounting.
- **packages/sources** — job-source adapters (Greenhouse, Lever, Ashby), JSON-LD generic reader, URL import routing, normalization, HTML sanitizing, paced/retrying SSRF-safe HTTP (ADR-022, ADR-023).
- **packages/testkit** — fake providers, scripted fixtures, local fixture ATS pages, test DB factory.

Dependency direction: `apps/* → packages/*`; `domain` depends on nothing internal; `db, ai, browser, documents → domain, security, config, observability`. `ai` must not import `browser/submission` (lint-enforced).

## 2. Workflow (state machine, not a swarm)

```text
Job:  DISCOVERED → NORMALIZED → (FILTERED | ELIGIBLE) → SCORED → (SHORTLISTED | SKIPPED) → ARCHIVED

App:  DRAFT → TAILORING → VERIFYING → READY_TO_PREPARE → PREPARING
        → (AWAITING_USER_INPUT ⇄ PREPARING) → READY_FOR_REVIEW
        → APPROVED_TO_SUBMIT → SUBMITTING → (SUBMITTED | SUBMISSION_UNCERTAIN | FAILED)
      any non-terminal → WITHDRAWN; APPROVED_TO_SUBMIT → READY_FOR_REVIEW on revocation
      SUBMISSION_UNCERTAIN → (SUBMITTED | FAILED) only via explicit user resolution
```

Full transition tables and guards: [DATA_MODEL.md](DATA_MODEL.md) §State machines. Every transition writes an `audit_events` row in the same transaction.

Stage owners:

| Stage                                          | Owner                                                                 | LLM?                                            |
| ---------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| Discovery, normalization, dedupe, hard filters | Job Source Worker                                                     | No                                              |
| Requirements extraction, scoring               | Match Analyst                                                         | Yes (structured) — aggregation is deterministic |
| Tailoring                                      | Résumé Tailor                                                         | Yes (structured, fact IDs only)                 |
| Provenance check                               | Deterministic validator                                               | No                                              |
| Integrity review                               | Integrity Reviewer (Claude in hybrid)                                 | Yes                                             |
| Cover letter / answers                         | Application Drafter                                                   | Yes                                             |
| Answer classification                          | Deterministic classifier (+ model hint, never downgrades sensitivity) | Partly                                          |
| Form filling                                   | Form Preparation Agent via 12 restricted tools                        | Yes                                             |
| Approval + final click + confirmation          | Approval service + SubmissionService                                  | **No**                                          |

## 3. Operating modes

`research-only`, `prepare`, `review-each` (default), `dry-run` — enforced by a `ModePolicy` checked in services (not prompts). E.g. `dry-run` swaps HTTP/browser/provider ports for fixture implementations and the policy rejects any external write; `prepare` can never issue approval tokens.

## 4. AI provider architecture

```ts
interface AIProvider {
  readonly name: "openai" | "claude";
  health(): Promise<ProviderHealth>;
  run<TIn, TOut>(req: ProviderRequest<TIn, TOut>): Promise<ProviderResult<TOut>>;
}
```

`ProviderRequest` carries: task type, prompt id+version, trusted context, user input, **delimited untrusted content**, Zod output schema, `RunLimits` (deadline, AbortSignal, maxTurns, maxToolCalls, maxInputChars, maxOutputTokens, maxCostUsd), trace ID, idempotency key, `attemptedProviders`.

Router rules: never re-enter a provider already in `attemptedProviders`; retry only `RateLimit`/`Timeout`/`Unavailable` with capped exponential backoff + jitter up to `MAX_PROVIDER_RETRIES`; never retry `Authentication|Policy|QuotaExceeded|InvalidOutput (after repair)|Validation|Approval|AmbiguousSubmission`. `compare` mode is opt-in per request.

OpenAI orchestrates and owns the tool loop; Claude is reached only through the backend `delegate_to_claude` tool (bounded by `MAX_CLAUDE_DELEGATIONS_PER_RUN`). Claude runs with no built-in tools and a minimal environment (ADR-008).

## 5. Browser architecture

- Headed Chromium, dedicated profile under `BROWSER_PROFILE_DIR`, one `BrowserContext` per application.
- Route interception enforces the session's origin allowlist; downloads denied; popups closed unless approved; non-http(s) schemes blocked.
- `PageSnapshot` = numbered, redacted view of interactive elements with handles bound to a DOM-generation counter; any navigation or mutation observer event invalidates handles.
- Model tools (exactly): `inspect_page, list_interactive_elements, fill_text_field, select_option, set_checkbox (non-consent), upload_approved_file, click_safe_control, scroll, wait_for_page_state, ask_user, request_auth_handoff, ready_for_review`.
- ATS adapters (Greenhouse, Lever, Ashby) are deterministic and preferred; the generic path is stricter (more fields → `requires_user`).

## 6. Approval and submission

See [APPROVAL_MODEL.md](APPROVAL_MODEL.md). Summary: the user approves on the review screen → API issues a single-use token bound to a canonical binding (application, owner, URL, origin, job ID, snapshot hash, answer-set hash, artifact hashes, submit-control identity, iat, exp) → SubmissionService re-snapshots, recomputes the binding, atomically consumes, clicks once, evaluates the adapter's success predicates → `SUBMITTED` or `SUBMISSION_UNCERTAIN` (never retried) or `FAILED` (only when the site clearly rejected before acceptance).

## 7. Data and privacy

SQLite in `DATA_DIR`, WAL; sensitive columns AES-256-GCM (ADR-005). Artifacts content-addressed by SHA-256 under `ARTIFACT_DIR`, immutable. Logs are structured metadata with redaction; full prompts/outputs stored only if `STORE_FULL_PROMPTS` / `STORE_FULL_MODEL_OUTPUTS`. Backup/export and full deletion are CLI + API commands.

## 8. Local security posture

Loopback bind and remote-address check; `LOCAL_SESSION_SECRET` signs the session cookie (`HttpOnly`, `SameSite=Strict`); CSRF double-submit token + `Origin`/`Host` validation (DNS-rebinding defence); CSP without `unsafe-eval`; job HTML sanitized before render. Details in [THREAT_MODEL.md](THREAT_MODEL.md).
