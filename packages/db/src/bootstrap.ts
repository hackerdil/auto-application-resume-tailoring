import path from "node:path";
import { ConfigError, loadConfig, requireSetting, type AppConfig } from "@career-agent/config";
import { createStore, type Store } from "./index.js";
import { FieldCipher, parseDataKey } from "@career-agent/security";

export interface Bootstrapped {
  config: AppConfig;
  cipher: FieldCipher;
  store: Store;
  ownerId: string;
  artifactDir: string;
}

/** Shared startup for the API and CLIs: validated config, encryption key, migrated store, the local owner. */
export function bootstrap(source: Record<string, string | undefined> = process.env): Bootstrapped {
  const config: AppConfig = loadConfig(source);
  const keyB64 = requireSetting(config, "DATA_ENCRYPTION_KEY");
  const cipher = new FieldCipher("k1", { k1: parseDataKey(keyB64) });
  if (config.databasePath === ":memory:" && config.env.NODE_ENV === "production") {
    throw new ConfigError(["DATABASE_URL=:memory: is not allowed in production."]);
  }
  const store = createStore({ file: config.databasePath, cipher });
  const owner = store.users.ensureOwner("Owner");
  return {
    config,
    cipher,
    store,
    ownerId: owner.id,
    artifactDir: path.resolve(config.env.ARTIFACT_DIR),
  };
}
