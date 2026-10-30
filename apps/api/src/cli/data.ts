// Local data commands: `pnpm data:export [--out <file>]` and `pnpm data:delete --confirm "DELETE MY DATA"`.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "@career-agent/config";

import { bootstrap, deleteLocalData, exportAllData } from "@career-agent/db";

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
    console.error('Usage: data export [--out <file>] | data delete --confirm "DELETE MY DATA"');
    process.exit(2);
  }
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
