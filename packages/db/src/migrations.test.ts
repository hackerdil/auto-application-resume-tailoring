import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./database.js";

const EXPECTED_TABLES = [
  "agent_runs",
  "application_answers",
  "application_approvals",
  "application_fields",
  "applications",
  "artifacts",
  "audit_events",
  "browser_sessions",
  "candidate_profiles",
  "companies",
  "cover_letter_versions",
  "document_texts",
  "fact_candidates",
  "fact_sources",
  "facts",
  "follow_ups",
  "idempotency_keys",
  "job_fetches",
  "job_requirements",
  "job_sources",
  "jobs",
  "match_results",
  "profile_versions",
  "provider_runs",
  "resume_bullets",
  "resume_templates",
  "resume_versions",
  "saved_answers",
  "tasks",
  "users",
];

const JOURNAL_ENTRIES = (
  JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

describe("migrations", () => {
  it("create every documented table on a fresh database, and re-running is a no-op", () => {
    const { db, sqlite, close } = openDatabase(":memory:");
    runMigrations(db);
    runMigrations(db);
    const tables = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(EXPECTED_TABLES);
    const triggers = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(triggers).toEqual([
      "application_answers_review_user_only_ins",
      "application_answers_review_user_only_upd",
      "application_approvals_final",
      "application_fields_no_update",
      "applications_terminal",
      "artifacts_no_update",
      "audit_events_no_delete",
      "audit_events_no_update",
      "browser_sessions_ended_final",
      "browser_sessions_status_valid",
      "browser_sessions_status_valid_upd",
      "cover_letter_versions_immutable",
      "cover_letter_versions_no_delete",
      "cover_letter_versions_status_valid",
      "fact_candidates_decided_final",
      "facts_no_delete",
      "facts_supersede_only",
      "idempotency_keys_no_update",
      "profile_versions_no_update",
      "resume_bullets_no_delete",
      "resume_bullets_no_update",
      "resume_versions_immutable",
      "resume_versions_no_delete",
      "resume_versions_status_valid",
      "users_single_owner",
    ]);
    const applied = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
      n: number;
    };
    expect(applied.n).toBe(JOURNAL_ENTRIES);
    close();
  });

  it("uses WAL, foreign keys, and owner-only directory permissions for file databases", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-db-"));
    const file = path.join(dir, "nested", "db.sqlite");
    const { db, sqlite, close } = openDatabase(file);
    runMigrations(db);
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    close();
    const { statSync } = await import("node:fs");
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});
