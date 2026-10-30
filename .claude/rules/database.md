---
paths:
  - "packages/db/**"
---

# Database rules

- Schema changes only through Drizzle migrations; migrations must run on a fresh DB and upgrade the previous fixture DB.
- Repositories implement interfaces from `packages/domain`; no Drizzle types leak into domain or apps.
- State transitions and their `audit_events` rows are written in one transaction.
- `audit_events` and `artifacts` are append-only (enforced by triggers + tests). Facts are append-only; corrections supersede.
- Sensitive columns are encrypted via `packages/security` (ADR-005); never index ciphertext.
- Use foreign keys, unique constraints (one application per user+job, unique canonical job IDs, unique idempotency keys), UTC epoch-ms timestamps, UUIDv7 IDs.
- Approval consumption is a single conditional `UPDATE` that must affect exactly one row.
- Test constraints, idempotency, and append-only guarantees.
