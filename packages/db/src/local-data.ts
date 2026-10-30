import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PolicyError } from "@career-agent/domain";
import type { Store } from "./index.js";

/**
 * Full local export (spec §17): every user-owned record, with encrypted columns decrypted, as plain JSON.
 * The caller writes it to an owner-only file. Audit events are included for transparency.
 */
export function exportAllData(store: Store, userId: string) {
  const all = (sql: string) => store.sqlite.prepare(sql).all() as Record<string, unknown>[];
  return {
    format: "career-agent-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: store.profiles.get(userId),
    profileVersions: store.profiles.listVersions(userId),
    facts: all("SELECT id FROM facts ORDER BY id").map((r) => store.facts.get(String(r["id"]))),
    pendingSuggestions: store.candidates.list(userId, "pending"),
    savedAnswers: store.savedAnswers.listActive(userId),
    artifacts: all(
      "SELECT id, sha256, media_type, byte_size, kind, created_at FROM artifacts ORDER BY id",
    ),
    jobs: all("SELECT id, status, data FROM jobs ORDER BY id").map((r) => ({
      ...r,
      data: JSON.parse(String(r["data"])) as unknown,
    })),
    applications: all(
      "SELECT id, job_id, state, created_at, updated_at FROM applications ORDER BY id",
    ),
    auditEvents: all(
      "SELECT id, at, trace_id, actor, type, prev_state, new_state, application_id, job_id, metadata FROM audit_events ORDER BY at, id",
    ),
  };
}

export interface DeletionTargets {
  databaseFile: string;
  directories: string[];
}

/** Refuses obviously dangerous targets so a misconfigured path can never wipe a home directory or a root. */
export function assertSafeDeletionTarget(p: string): string {
  const abs = path.resolve(p);
  const forbidden = new Set(
    [path.parse(abs).root, homedir(), process.cwd(), path.dirname(process.cwd())].map((x) =>
      path.resolve(x),
    ),
  );
  if (forbidden.has(abs))
    throw new PolicyError(`Refusing to delete ${abs}: it is a root, home, or working directory.`);
  if (abs.split(path.sep).filter(Boolean).length < 2)
    throw new PolicyError(`Refusing to delete ${abs}: path is too shallow.`);
  return abs;
}

/**
 * Deletes all local data: the database (+WAL/SHM), and the contents of the artifact, browser-profile, Claude
 * workspace, and export directories. `.gitkeep` markers are preserved. Returns what was removed.
 */
export function deleteLocalData(targets: DeletionTargets): string[] {
  const removed: string[] = [];
  const db = assertSafeDeletionTarget(targets.databaseFile);
  for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  for (const dir of targets.directories.map(assertSafeDeletionTarget)) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (entry === ".gitkeep") continue;
      const p = path.join(dir, entry);
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  }
  return removed;
}
