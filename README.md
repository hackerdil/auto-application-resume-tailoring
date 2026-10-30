# Career Agent

A local-first, human-in-the-loop tool that helps **one person**, acting for themselves, find relevant jobs and prepare truthful applications. You review every application and approve it before it is submitted.

> **Status: Phase 8 (approval and submission) complete.** Prepare an application per job, let Career Agent fill the employer's form in a separate browser window, review it, and approve. Only then does Career Agent press the form's submit button, once, after checking that nothing changed since your approval. Model-driven orchestration arrives in Phase 9. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## What it does

1. Builds a verified fact bank from your résumé and your explicit answers.
2. Discovers jobs from public ATS job-board APIs (Greenhouse, Lever, Ashby) and URLs you import.
3. Normalizes, deduplicates, filters, and scores jobs, showing the evidence behind each score.
4. Tailors your résumé using only verified facts, with every bullet traced to its source.
5. Drafts cover letters and answers, and asks you about anything sensitive or unknown.
6. Prefills the application in an isolated, visible browser, then stops for your review.
7. Submits only after you approve that specific application, and records it as submitted only when the site confirms it.

## What it does not do

- Apply for anyone else, rank other applicants, or make employment decisions.
- Scrape LinkedIn, Indeed, or any site whose terms prohibit it. These sites are excluded because their terms prohibit automation and their data sits behind login and anti-bot controls (see [ADR-010](docs/DECISIONS.md)).
- Solve CAPTCHAs, bypass MFA or anti-bot checks, accept terms, sign attestations, or answer demographic questions for you.
- Auto-submit silently or send messages to recruiters.
- Claim that its match score is an employer ATS score or a hiring prediction.

## Privacy model

Everything runs on your machine and listens only on `127.0.0.1`. Sensitive fields are encrypted at rest. Secrets, your data, browser profiles, and generated documents are never committed. Job text and the relevant résumé facts are sent to the AI providers you enable (OpenAI, and Claude through your Claude Code login). Use `research-only` or `dry-run` mode to limit this. Details: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Prerequisites

- Node.js ≥ 22.12 (22 or 24 LTS recommended)
- pnpm 10 (`npm i -g pnpm@10`)
- Playwright Chromium for browser preparation: `pnpm --filter @career-agent/browser exec playwright install chromium` (an installed Google Chrome is used when it is missing).
- Later phases: an OpenAI API key, and Claude Code signed in for subscription mode.

## Getting started

```bash
pnpm install
```

```bash
cp .env.example .env
```

Generate two different secrets and set them as `LOCAL_SESSION_SECRET` and `DATA_ENCRYPTION_KEY` in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
pnpm db:migrate
```

```bash
pnpm dev
```

Open http://127.0.0.1:3000. Keep a copy of `DATA_ENCRYPTION_KEY`: without it, encrypted data cannot be recovered. More in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Commands

| Command                                       | Purpose                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`                                    | Watch build + API + worker + web UI on 127.0.0.1                               |
| `pnpm check`                                  | Format check, lint, typecheck (including the web app), tests                   |
| `pnpm build`                                  | TypeScript project build + `next build`                                        |
| `pnpm test`                                   | Vitest unit/integration tests (no network, no paid calls)                      |
| `pnpm db:migrate`                             | Apply database migrations to `DATABASE_URL`                                    |
| `pnpm data:export [--out file]`               | Plaintext JSON export of all your data (owner-only file)                       |
| `pnpm data:delete --confirm "DELETE MY DATA"` | Delete all local data (database, résumés, artifacts, browser profile, exports) |
| `pnpm test:browser`                           | Headless browser tests against local fictional ATS forms                       |

## Operating modes

`research-only` · `prepare` · `review-each` (default; one approval per application) · `dry-run` (fixtures only, no external writes). Unattended auto-submit is intentionally not implemented.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Threat model](docs/THREAT_MODEL.md)
- [Data model](docs/DATA_MODEL.md) · [Approval model](docs/APPROVAL_MODEL.md) · [Prompt security](docs/PROMPT_SECURITY.md)
- [Operations](docs/OPERATIONS.md) · [User guide](docs/USER_GUIDE.md) (completed in Phase 10)

Sections still to come as features land: OpenAI setup and cost controls, Claude subscription authentication and limits, provider fallback behavior, browser and approval flow, backup, and troubleshooting.

## Responsible use

You are responsible for following each job site's terms and for the truthfulness of what you submit. The tool is built to keep you in control. Read every review screen before approving.

## Security

Please report vulnerabilities privately to the repository owner rather than in a public issue. A `SECURITY.md` with a contact address will be added before the first release.
