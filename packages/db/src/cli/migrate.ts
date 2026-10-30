// `pnpm db:migrate`: applies pending migrations to the configured database.
import { loadConfig } from "@career-agent/config";
import { openDatabase, runMigrations } from "../database.js";

const config = loadConfig();
if (config.databasePath === ":memory:") {
  console.error("DATABASE_URL is :memory:; nothing to migrate.");
  process.exit(1);
}
const { db, sqlite, close } = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
    n: number;
  };
  console.log(`Database migrated (${row.n} migrations applied).`);
} finally {
  close();
}
