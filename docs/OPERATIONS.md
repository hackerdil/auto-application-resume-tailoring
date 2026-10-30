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

## Still to document (Phase 10)

Backup/restore, key rotation (`FieldCipher` supports key ids; the re-encryption job is not built yet), resolving `SUBMISSION_UNCERTAIN` applications, provider health and quota exhaustion, log/screenshot retention.
