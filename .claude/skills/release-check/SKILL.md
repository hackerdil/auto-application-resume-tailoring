---
name: release-check
description: Effect-free pre-release checklist. Runs the full validation suite, inspects git state, verifies migrations/docs/env examples, scans for tracked secrets or personal data, and reports blockers. Manual invocation only.
disable-model-invocation: true
allowed-tools:
  - Bash(pnpm check)
  - Bash(pnpm build)
  - Bash(pnpm test:browser)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git ls-files *)
  - Bash(node scripts/scan-fixtures.mjs)
  - Read
  - Grep
  - Glob
---

# Release check

This skill never deploys, publishes, pushes, tags, or sends data anywhere. Report only.

1. `git status --porcelain` and `git diff --stat`: list uncommitted or untracked files.
2. Run `pnpm check`, `pnpm build`, and `pnpm test:browser`. Record pass/fail with the failing output; do not modify tests.
3. Migrations: every schema change in `packages/db` has a migration; migrations apply to a fresh DB (covered by tests).
4. Docs: `.env.example` keys match `packages/config` schema; README commands match `package.json` scripts; `docs/IMPLEMENTATION_PLAN.md` status is accurate.
5. Secrets and personal data: `git ls-files` must contain no `.env`, `*.sqlite*`, `data/**` (except `.gitkeep`), `artifacts/**` (except `.gitkeep`), browser profiles, PDFs/DOCX outside `fixtures/**/*.fixture.*`. Run `node scripts/scan-fixtures.mjs`.
6. Invariants: confirm the no-submit-by-construction, approval replay/mutation, and provenance tests exist and pass.

Output a table: check · status · evidence · blocker (yes/no). End with "Release blocked" or "No blockers found".
