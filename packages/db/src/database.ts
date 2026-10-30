import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/** `src/` and `dist/` both sit next to `drizzle/`, so this resolves the same from source and build output. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Opens the SQLite database with safe pragmas. Creates the parent directory with owner-only permissions.
 * Pass ":memory:" for tests.
 */
export function openDatabase(file: string): OpenedDatabase {
  if (file !== ":memory:")
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const sqlite = new Database(file);
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("trusted_schema = OFF");
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => {
      sqlite.close();
    },
  };
}

export function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder });
}
