# Career Agent

A local-first, human-in-the-loop tool that helps **one person**, acting for themselves, find relevant jobs and prepare truthful applications. You review every application and approve it before it is submitted.

> **Status: all ten phases complete** ([plan](docs/IMPLEMENTATION_PLAN.md)). Try it safely with `pnpm demo`: fictional data, local forms, no AI calls, nothing can be submitted.

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
- Optional: an OpenAI API key (and model id) and/or Claude Code signed in. Without them everything works rule-based.

## Try the demo first

```bash
pnpm install
```

```bash
pnpm demo
```

Open http://127.0.0.1:3000. The demo uses a separate database under `data/demo/`, fictional people, companies, and jobs, and fictional application forms served on this machine. It runs in `dry-run` mode with no AI provider, so you can tailor a résumé, start an application, and watch the browser fill a form, but nothing can be approved or submitted. Your `.env` is not read.

## Getting started

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
| `pnpm test:browser`                           | Browser tests and the end-to-end/accessibility suite (run `pnpm build` first)  |
| `pnpm demo`                                   | Build and start the fictional demo (dry-run, no AI, local forms only)          |
| `pnpm data:backup [--out dir]`                | Database + files backup with SHA-256 manifest (keys are not included)          |
| `pnpm data:restore --from dir [--force]`      | Verify and restore a backup; `--force` moves the current database aside        |

## Operating modes

`OPERATING_MODE`: `research-only` · `prepare` · `review-each` (default; one approval per application) · `dry-run` (fixtures only, no approvals or submissions). Unattended auto-submit is intentionally not implemented.

## AI providers

OpenAI is the primary orchestrator through the official Agents SDK: set `OPENAI_API_KEY` and `OPENAI_MODEL` (no default model is assumed), and optionally your model's prices to see costs. Claude runs through the official Claude Agent SDK with your own Claude Code login, with no tools and no access to files or secrets; it counts against your plan's limits. `DEFAULT_PROVIDER_MODE` picks the routing (`hybrid` by default: OpenAI does the work, Claude reviews résumé claims and takes over when OpenAI is unavailable). Retries and fallback are bounded and never loop. Career Agent never uses claude.ai or ChatGPT web sessions or cookies. Details: [docs/OPERATIONS.md](docs/OPERATIONS.md#ai-providers).

## Browser, sign-in, and approval

Career Agent fills the employer's form in its own visible browser window with a separate profile (`BROWSER_PROFILE_DIR`). You sign in, enter codes, solve CAPTCHAs, and tick consent boxes yourself. While preparing, the window cannot send anything to the employer. After you review the filled form and approve, Career Agent checks that nothing changed and presses the submit button once; it records "submitted" only when the site confirms, and asks you when it cannot tell. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Job sources

Greenhouse, Lever, and Ashby public job-board APIs, plus job URLs you import. LinkedIn, Indeed, and similar sites are excluded because their terms prohibit automated access ([ADR-010](docs/DECISIONS.md)).

## Known limitations

- Only the three ATS adapters are tuned; other sites use a stricter generic path.
- Forms that upload or autosave in the background, use WebSockets, or submit to another site need you to finish those parts, or end as "could not tell".
- Confirmation detection is text-based and verified against fixtures only.
- No scheduled discovery yet; no OCR for scanned résumés; no monthly budget cap; `compare` provider mode routes like `hybrid`.
- No live AI smoke test has been run by the project; enable `ENABLE_LIVE_AI_TESTS` only if you accept the cost.

Roadmap: scheduled discovery, more ATS adapters (Workable after a terms review), budget caps, and key rotation tooling.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Threat model](docs/THREAT_MODEL.md)
- [Data model](docs/DATA_MODEL.md) · [Approval model](docs/APPROVAL_MODEL.md) · [Prompt security](docs/PROMPT_SECURITY.md)
- [Operations and troubleshooting](docs/OPERATIONS.md) · [User guide](docs/USER_GUIDE.md) · [Security policy](SECURITY.md)

## Responsible use

You are responsible for following each job site's terms and for the truthfulness of what you submit. The tool is built to keep you in control. Read every review screen before approving.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
