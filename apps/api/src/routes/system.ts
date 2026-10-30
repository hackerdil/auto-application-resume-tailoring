import type { FastifyInstance } from "fastify";
import type { AppConfig, ProviderStatus } from "@career-agent/config";
import { exportAllData, type Store } from "@career-agent/db";
import type { LocalGuard } from "../local-guard.js";

const publicStatus = (s: ProviderStatus) =>
  !s.enabled ? "disabled" : s.ready ? "configured" : "unavailable";

export function registerSystemRoutes(
  app: FastifyInstance,
  d: { guard: LocalGuard; store: Store; ownerId: string; config: AppConfig },
) {
  app.get("/api/v1/health", () => ({ status: "ok" }));

  app.get("/api/v1/ready", () => {
    d.store.sqlite.prepare("SELECT 1").get();
    return {
      status: "ready",
      providers: {
        openai: publicStatus(d.config.providers.openai),
        claude: publicStatus(d.config.providers.claude),
      },
    };
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
