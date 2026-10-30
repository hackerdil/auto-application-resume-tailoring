import { z } from "zod";
import { parseBody } from "../http-errors.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig, ProviderStatus } from "@career-agent/config";
import { exportAllData, type Store } from "@career-agent/db";
import type { ProviderRouter } from "@career-agent/ai";
import type { LocalGuard } from "../local-guard.js";

const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const publicStatus = (s: ProviderStatus) =>
  !s.enabled ? "disabled" : s.ready ? "configured" : "unavailable";

export function registerSystemRoutes(
  app: FastifyInstance,
  d: {
    guard: LocalGuard;
    store: Store;
    ownerId: string;
    config: AppConfig;
    router?: ProviderRouter | null;
    now?: () => number;
  },
) {
  app.get("/api/v1/health", () => ({ status: "ok" }));

  app.get("/api/v1/ready", () => {
    d.store.sqlite.prepare("SELECT 1").get();
    return {
      status: "ready",
      demo: d.config.env.DEMO_MODE,
      mode: d.config.env.OPERATING_MODE,
      providers: {
        openai: publicStatus(d.config.providers.openai),
        claude: publicStatus(d.config.providers.claude),
      },
    };
  });

  // Phase 9: provider health (configuration, Claude workspace, recent failures) without contacting a provider.
  app.get("/api/v1/system/providers", async (req) => {
    d.guard.requireSession(req);
    return {
      mode: d.config.env.DEFAULT_PROVIDER_MODE,
      providers: d.router ? await d.router.healthReport() : [],
      limits: {
        openaiMaxCostUsdPerRun: d.config.env.OPENAI_MAX_COST_USD_PER_RUN,
        claudeMaxCostUsdPerRun: d.config.env.CLAUDE_MAX_COST_USD_PER_RUN,
        maxClaudeDelegationsPerRun: d.config.env.MAX_CLAUDE_DELEGATIONS_PER_RUN,
        openaiPricingConfigured:
          d.config.env.OPENAI_INPUT_USD_PER_MTOK !== undefined &&
          d.config.env.OPENAI_OUTPUT_USD_PER_MTOK !== undefined,
      },
    };
  });

  app.get("/api/v1/system/usage", (req) => {
    d.guard.requireSession(req);
    const { days } = parseBody(UsageQuery, req.query);
    const since = new Date((d.now ?? Date.now)() - days * 86_400_000).toISOString();
    return { since, rows: d.store.providerRuns.usageSince(since) };
  });

  app.get("/api/v1/session", (req, reply) => ({ csrfToken: d.guard.issueSession(req, reply) }));

  app.get("/api/v1/export", (req, reply) => {
    d.guard.requireSession(req);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    void reply.header(
      "content-disposition",
      `attachment; filename="career-agent-export-${stamp}.json"`,
    );
    return exportAllData(d.store, d.ownerId);
  });
}
