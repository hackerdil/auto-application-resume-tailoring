import { createAIProviders, failureRecorder, recorded } from "@career-agent/ai";
import { ConfigError, providerSettings, requireSetting } from "@career-agent/config";
import { createLogger } from "@career-agent/observability";
import { buildApp } from "./app.js";
import { bootstrap } from "@career-agent/db";
import { documentPorts } from "./documents.js";

try {
  const { config, store, ownerId, artifactDir } = bootstrap();
  const sessionSecret = Buffer.from(requireSetting(config, "LOCAL_SESSION_SECRET"), "base64");
  const logger = createLogger({
    level: config.env.LOG_LEVEL,
    secretValues: [
      config.env.OPENAI_API_KEY,
      config.env.DATA_ENCRYPTION_KEY,
      config.env.LOCAL_SESSION_SECRET,
    ].filter((v): v is string => !!v),
  });
  for (const w of config.warnings) logger.warn(w);
  const settings = providerSettings(config);
  const ai = createAIProviders({ ...settings, onFailure: failureRecorder(store.providerRuns) });
  // Model extraction adds candidates only when their evidence is verbatim in the résumé (ADR in Phase 2).
  const extractor = ai.router.available
    ? recorded(ai.router, (r) => {
        store.providerRuns.record(r);
      })
    : null;
  const app = await buildApp({
    config,
    store,
    ownerId,
    documents: documentPorts(artifactDir, extractor),
    ai: { router: ai.router, secretValues: settings.secretValues },
    artifactDir,
    sessionSecret,
    logger,
  });
  await app.listen({ host: config.env.HOST, port: config.env.API_PORT });
  const shutdown = () => {
    void app.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
