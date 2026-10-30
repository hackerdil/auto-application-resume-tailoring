// Local data commands: `pnpm data:export [--out <file>]`, `pnpm data:backup [--out <dir>]`,
// `pnpm data:restore --from <dir> [--force]`, and `pnpm data:delete --confirm "DELETE MY DATA"`.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "@career-agent/config";
import { CareerAgentError } from "@career-agent/domain";

import {
  bootstrap,
  createBackup,
  deleteLocalData,
  exportAllData,
  restoreBackup,
} from "@career-agent/db";

const CONFIRM_PHRASE = "DELETE MY DATA";
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

try {
  if (command === "export") {
    const { config, store, ownerId } = bootstrap();
    const out = path.resolve(
      flag("--out") ??
        path.join(
          config.env.DATA_DIR,
          "exports",
          `export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        ),
    );
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, JSON.stringify(exportAllData(store, ownerId), null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    store.close();
    console.log(
      `Exported to ${out} (readable only by you). It contains your personal data in plain text.`,
    );
  } else if (command === "backup") {
    const { config, store, artifactDir } = bootstrap();
    const { dir, manifest } = await createBackup(store, {
      artifactDir,
      outDir: path.resolve(flag("--out") ?? path.join(config.env.DATA_DIR, "backups")),
    });
    store.close();
    console.log(
      `Backed up the database and ${manifest.artifacts.length} file(s) to ${dir}.\nEncrypted fields stay encrypted: keep DATA_ENCRYPTION_KEY safe separately, or this backup cannot be read.`,
    );
  } else if (command === "restore") {
    const from = flag("--from");
    if (!from) {
      console.error("Usage: data restore --from <backup folder> [--force]");
      process.exit(2);
    }
    const { env, databasePath } = loadConfig();
    const r = restoreBackup(path.resolve(from), {
      databaseFile: databasePath,
      artifactDir: path.resolve(env.ARTIFACT_DIR),
      force: rest.includes("--force"),
    });
    console.log(
      `Restored the backup from ${r.manifest.createdAt}.${r.movedAside ? ` Your previous database was kept at ${r.movedAside}.` : ""}`,
    );
  } else if (command === "delete") {
    if (flag("--confirm") !== CONFIRM_PHRASE) {
      console.error(
        `This permanently deletes your local database, résumés, artifacts, browser profile, and exports.\nRe-run with: --confirm "${CONFIRM_PHRASE}"`,
      );
      process.exit(2);
    }
    const { env, databasePath } = loadConfig();
    const removed = deleteLocalData({
      databaseFile: databasePath,
      directories: [
        env.ARTIFACT_DIR,
        env.BROWSER_PROFILE_DIR,
        env.CLAUDE_WORKING_DIRECTORY,
        path.join(env.DATA_DIR, "exports"),
      ],
    });
    console.log(
      `Deleted ${removed.length} item(s). Your .env and encryption keys were not touched.`,
    );
  } else {
    console.error(
      'Usage: data export [--out <file>] | data backup [--out <dir>] | data restore --from <dir> [--force] | data delete --confirm "DELETE MY DATA"',
    );
    process.exit(2);
  }
} catch (err) {
  if (err instanceof ConfigError || err instanceof CareerAgentError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
