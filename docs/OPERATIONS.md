# Operations

> Status: partial (Phase 3). Completed in Phase 10.

## First-time setup

1. `cp .env.example .env`
2. Generate secrets and paste them into `.env`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Use one value for `LOCAL_SESSION_SECRET` and a different one for `DATA_ENCRYPTION_KEY`. Losing `DATA_ENCRYPTION_KEY` makes encrypted data (profile, saved answers, résumé text, sensitive facts) unrecoverable. Keep a copy in your password manager.

3. `pnpm install && pnpm db:migrate`
4. `pnpm dev`, then open http://127.0.0.1:3000.

## Running

- `pnpm dev` builds the workspace, then runs the TypeScript watcher, the API (`API_PORT`, restarts on rebuild), and Next.js (`WEB_PORT`).
- Production-like: `pnpm build`, then `pnpm --filter @career-agent/api start` and `pnpm --filter @career-agent/web start`. The web build proxies to the `API_PORT` set at build time (ADR-020).
- Startup lists configuration problems all at once. Missing provider settings only disable those providers.

## Worker and discovery

- The worker (`apps/worker`, started by `pnpm dev`) claims leased tasks from the `tasks` table. If it crashes, the lease expires (5 min) and the task is picked up again on restart.
- Discovery failures are classified: unreachable/5xx/429 boards are retried up to 3 task attempts with backoff; not-found boards, schema changes, and policy blocks fail immediately and show on the Sources page.
- Only one discovery run per source can be queued or running at a time.
- `DISCOVERY_SCHEDULE_ENABLED` is not implemented yet (the worker logs a warning); run discovery from the Sources page.
- Default tests never contact real job boards. `ENABLE_LIVE_SOURCE_TESTS` is reserved for an explicitly authorized live contract check (none exists yet).

## Résumé rendering

- PDFs are printed by headless Chromium through Playwright. Install the bundled browser with `pnpm --filter @career-agent/documents exec playwright install chromium`; if it is missing, the installed Google Chrome is used instead (headless, temporary profile).
- Rendered files are stored content-addressed in `ARTIFACT_DIR` and are never modified; a new tailoring run creates new files.

## Export and deletion

- `pnpm data:export [--out <file>]` writes a plaintext JSON export (mode 0600; it never overwrites an existing file). Default location: `DATA_DIR/exports/`. The UI's "Export my data" link downloads the same content.
- `pnpm data:delete --confirm "DELETE MY DATA"` deletes the database (and WAL/SHM), the contents of `ARTIFACT_DIR`, `BROWSER_PROFILE_DIR`, `CLAUDE_WORKING_DIRECTORY`, and `DATA_DIR/exports`. It refuses root, home, working, and shallow directories. `.env` and keys are left alone.

## AI providers

- **OpenAI:** set `OPENAI_API_KEY` and `OPENAI_MODEL` (there is no default model). For cost tracking, also set `OPENAI_INPUT_USD_PER_MTOK` and `OPENAI_OUTPUT_USD_PER_MTOK` to your model's current prices.
- **Claude:** runs through your own Claude Code login (run `claude` once and sign in) and counts against your plan's limits. Career Agent never reads browser cookies or web sessions. Sign-in is checked on first use; a failure appears on **AI & usage** and falls back to OpenAI in `hybrid`/`auto` mode.
- **Mode:** `DEFAULT_PROVIDER_MODE` (`hybrid` by default). A provider that fails three times in a row is paused for a minute.
- **Without any provider:** scoring, résumés, letters, and preparation all keep working rule-based.
- **Model help with forms:** `BROWSER_MODEL_ASSIST=true` lets OpenAI continue forms the rule-based pass could not finish. It uses your OpenAI budget and stays within `BROWSER_MAX_STEPS` and `OPENAI_MAX_TURNS`.

## Backup and restore

- `pnpm data:backup [--out <dir>]` writes `backup-<time>/` (default under `DATA_DIR/backups/`, owner-only): an online SQLite backup, every stored file, and `manifest.json` with SHA-256 hashes. It can run while Career Agent is running.
- Encrypted fields stay encrypted. **Keep `DATA_ENCRYPTION_KEY` safe separately**: a backup cannot be read without it, and it is deliberately not in the backup.
- `pnpm data:restore --from <dir>` verifies every hash first, then restores the database and files and applies any newer migrations. It refuses to replace an existing database unless you add `--force`; the current database is then kept as `<name>.pre-restore-<time>`. Stop the API and worker before restoring.

## Keys

- `LOCAL_SESSION_SECRET` signs the local session and derives approval keys. Changing it signs you out and cancels pending approvals.
- `DATA_ENCRYPTION_KEY` encrypts sensitive fields. Ciphertexts carry a key id, so a second key can be added later, but a re-encryption command is not built yet: do not change this key on a database with data in it.

## Uncertain submissions

If Career Agent cannot tell whether a submission went through (a timeout, a dropped connection, an unexpected page, or a worker restart mid-submission), the application shows **Could not tell**. It is never retried automatically. Check the browser window or your email, then choose **It was submitted** or **It was not submitted** on the application page.

## Provider quota and outages

A provider that fails three times in a row is paused for a minute and shown as unavailable on **AI & usage**. In `hybrid`/`auto` mode the other provider takes over; otherwise features fall back to rule-based behavior. Quota and sign-in errors are not retried. Per-run cost limits (`OPENAI_MAX_COST_USD_PER_RUN`, `CLAUDE_MAX_COST_USD_PER_RUN`) stop a run cleanly.

## Logs and retention

Logs are structured metadata with secrets and personal values redacted; prompts and model outputs are not stored by default (`STORE_FULL_PROMPTS`, `STORE_FULL_MODEL_OUTPUTS`). Career Agent does not take screenshots yet, so `SCREENSHOT_RETENTION_DAYS` and `STORE_REDACTED_SCREENSHOTS` have no effect. Delete everything with `pnpm data:delete`.

## Demo

`pnpm demo` builds and starts a separate, fictional instance under `data/demo/` with its own generated keys (`data/demo/demo-keys.json`). It sets `DEMO_MODE=true` and `OPERATING_MODE=dry-run`, disables both AI providers, and lets the browser open only forms on this machine. It never reads your `.env`. It uses ports 3000, 3001, and 3102, so stop your own instance first.

## Troubleshooting

- **"LOCAL_SESSION_SECRET is required"**: set it in `.env` (see the README).
- **Claude unavailable / not signed in**: run `claude` once in a terminal and sign in; check **AI & usage**.
- **OpenAI unavailable**: both `OPENAI_API_KEY` and `OPENAI_MODEL` must be set; a 401 means the key is wrong, "no quota left" means the account needs credit.
- **Browser does not open / "Executable doesn't exist"**: install Chromium (see Prerequisites) or Google Chrome.
- **The form says "Your turn in the browser window"**: sign in, solve the CAPTCHA, or tick the boxes yourself, then press **Continue**.
- **"The review is out of date"**: press **Refresh review**, then approve within `APPROVAL_TTL_SECONDS`.
- **Ports in use**: change `WEB_PORT`/`API_PORT` in `.env` and rebuild the web app (`pnpm build`), because the web app's API proxy is fixed at build time.
- **E2E tests fail with "Port … is in use"**: stop any running Career Agent instance; the suite uses the demo ports.
