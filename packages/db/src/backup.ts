import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PolicyError, ValidationError } from "@career-agent/domain";
import { resolveInside, sha256Hex } from "@career-agent/security";
import { z } from "zod";
import { openDatabase, runMigrations } from "./database.js";
import type { Store } from "./index.js";

const Manifest = z.object({
  format: z.literal("career-agent-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  migrations: z.number().int().nonnegative(),
  database: z.object({
    file: z.literal("database.sqlite"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  artifacts: z.array(
    z.object({ storagePath: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  ),
});
export type BackupManifest = z.infer<typeof Manifest>;

/**
 * Local backup (spec §17): an online SQLite backup plus every stored artifact, with SHA-256 hashes in a manifest.
 * Encrypted columns stay encrypted: restoring needs the same DATA_ENCRYPTION_KEY, which is never written here.
 * The folder is owner-only.
 */
export async function createBackup(
  store: Store,
  opts: { artifactDir: string; outDir: string; now?: Date },
): Promise<{ dir: string; manifest: BackupManifest }> {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(opts.outDir, `backup-${stamp}`);
  if (existsSync(dir)) throw new PolicyError(`${dir} already exists.`);
  mkdirSync(path.join(dir, "artifacts"), { recursive: true, mode: 0o700 });
  const dbFile = path.join(dir, "database.sqlite");
  await store.sqlite.backup(dbFile);
  const artifacts = (
    store.sqlite
      .prepare("SELECT storage_path AS storagePath, sha256 FROM artifacts ORDER BY id")
      .all() as {
      storagePath: string;
      sha256: string;
    }[]
  ).map((a) => {
    const from = resolveInside(opts.artifactDir, a.storagePath);
    const to = resolveInside(path.join(dir, "artifacts"), a.storagePath);
    if (sha256Hex(readFileSync(from)) !== a.sha256)
      throw new ValidationError(
        `Artifact ${a.storagePath} does not match its hash; backup stopped.`,
      );
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    return a;
  });
  const migrations = (
    store.sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }
  ).n;
  const manifest: BackupManifest = {
    format: "career-agent-backup",
    version: 1,
    createdAt: (opts.now ?? new Date()).toISOString(),
    migrations,
    database: { file: "database.sqlite", sha256: sha256Hex(readFileSync(dbFile)) },
    artifacts,
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return { dir, manifest };
}

/** Checks the manifest and every file hash. Throws ValidationError naming the first problem. */
export function verifyBackup(dir: string): BackupManifest {
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(manifestFile))
    throw new ValidationError("This folder is not a Career Agent backup.");
  const parsed = Manifest.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")));
  if (!parsed.success) throw new ValidationError("The backup manifest is not valid.");
  const m = parsed.data;
  if (sha256Hex(readFileSync(path.join(dir, m.database.file))) !== m.database.sha256)
    throw new ValidationError("The backed-up database does not match its hash.");
  for (const a of m.artifacts) {
    const f = resolveInside(path.join(dir, "artifacts"), a.storagePath);
    if (!existsSync(f) || sha256Hex(readFileSync(f)) !== a.sha256)
      throw new ValidationError(`Backed-up artifact ${a.storagePath} is missing or changed.`);
  }
  return m;
}

/**
 * Restores a verified backup. An existing database is never overwritten silently: without `force` restore
 * refuses; with it, the current database is first moved aside. The restored database is migrated forward.
 */
export function restoreBackup(
  dir: string,
  opts: { databaseFile: string; artifactDir: string; force?: boolean; now?: Date },
): { manifest: BackupManifest; movedAside: string | null } {
  const m = verifyBackup(dir);
  const target = path.resolve(opts.databaseFile);
  let movedAside: string | null = null;
  if (existsSync(target)) {
    if (!opts.force)
      throw new PolicyError(`${target} exists. Re-run with --force to move it aside and restore.`);
    movedAside = `${target}.pre-restore-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
    renameSync(target, movedAside);
    for (const ext of ["-wal", "-shm"])
      if (existsSync(`${target}${ext}`)) renameSync(`${target}${ext}`, `${movedAside}${ext}`);
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(path.join(dir, m.database.file), target);
  for (const a of m.artifacts) {
    const to = resolveInside(opts.artifactDir, a.storagePath);
    if (existsSync(to) && sha256Hex(readFileSync(to)) === a.sha256) continue;
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(resolveInside(path.join(dir, "artifacts"), a.storagePath), to);
  }
  const opened = openDatabase(target);
  try {
    runMigrations(opened.db);
  } finally {
    opened.sqlite.close();
  }
  return { manifest: m, movedAside };
}
