import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, openDatabase, runMigrations } from "./database.js";

/** Builds a migrations folder containing only the first `n` journal entries (an older schema version). */
function olderMigrations(n: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ca-mig-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const JOURNAL_ENTRIES = (
  JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: unknown[];
  }
).entries.length;

describe("schema upgrade", () => {
  it("upgrades a Phase 1 database (migrations 0000–0001) without losing data", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ca-up-")), "old.sqlite");
    const old = openDatabase(file);
    runMigrations(old.db, olderMigrations(2));
    old.sqlite
      .prepare(
        "INSERT INTO users VALUES ('0190f0b0-0000-7000-8000-000000000001', 'Alex Example', 1)",
      )
      .run();
    old.sqlite
      .prepare(
        "INSERT INTO facts (id, user_id, category, claim, source, verified_at, allowed_transformations, sensitive, created_at) VALUES ('0190f0b0-0000-7000-8000-000000000002', '0190f0b0-0000-7000-8000-000000000001', 'skill', 'TypeScript', 'user-confirmed', 1, '[\"select\"]', 0, 1)",
      )
      .run();
    old.sqlite
      .prepare(
        "INSERT INTO audit_events (id, at, trace_id, actor, type, artifact_hashes, metadata) VALUES ('0190f0b0-0000-7000-8000-000000000003', 1, 't', 'user', 'fact.added', '[]', '{}')",
      )
      .run();
    expect(() => old.sqlite.prepare("SELECT 1 FROM fact_candidates").get()).toThrow(
      /no such table/,
    );
    old.close();

    const upgraded = openDatabase(file);
    runMigrations(upgraded.db);
    expect(upgraded.sqlite.prepare("SELECT claim FROM facts").get()).toEqual({
      claim: "TypeScript",
    });
    expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({
      n: 1,
    });
    expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS n FROM fact_candidates").get()).toEqual({
      n: 0,
    });
    expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual(
      { n: JOURNAL_ENTRIES },
    );
    // Guards from the old schema still hold after the upgrade.
    expect(() => upgraded.sqlite.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
    upgraded.close();
  });
});
