import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DISCOVER_SOURCE_TASK,
  discoveryKeyPrefix as keyPrefix,
  JobSourceType,
  JobStatus,
  NotFoundError,
  type DiscoveryService,
  type MatchingService,
} from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const AddSource = z.object({
  type: JobSourceType,
  identifier: z.string().trim().min(1).max(110),
  displayName: z.string().trim().max(120).optional(),
});
const IdParams = z.object({ id: z.uuidv7() });
const RunDiscovery = z.object({ sourceIds: z.array(z.uuidv7()).max(100).optional() });
const ListJobs = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : undefined))
    .pipe(z.array(JobStatus).optional()),
  q: z.string().trim().max(200).optional(),
  sourceId: z.uuidv7().optional(),
  sort: z.enum(["recent", "score"]).default("recent"),
  limit: z.coerce.number<string>().int().min(1).max(200).default(50),
  offset: z.coerce.number<string>().int().min(0).default(0),
});
const JobIdQuery = z.object({ id: z.string().min(3).max(400) });
const SetStatus = z.object({
  id: z.string().min(3).max(400),
  to: z.enum(["SHORTLISTED", "SKIPPED", "ARCHIVED"]),
});
const ImportUrl = z.object({
  url: z.string().trim().min(8).max(2000),
  allowGenericReader: z.boolean().default(false),
});

export function registerJobRoutes(
  app: FastifyInstance,
  d: {
    guard: LocalGuard;
    store: Store;
    ownerId: string;
    discovery: DiscoveryService;
    matching: MatchingService;
  },
) {
  app.get("/api/v1/job-sources", (req) => {
    d.guard.requireSession(req);
    return {
      sources: d.store.jobSources.list().map((s) => ({
        ...s,
        lastFetch: d.store.jobFetches.latestForSource(s.id),
        running: d.store.tasks.hasActive(keyPrefix(s.id)),
      })),
    };
  });

  app.post("/api/v1/job-sources", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(AddSource, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 201,
      body: {
        source: d.discovery.addSource(
          { ...body, displayName: body.displayName ?? null },
          req.ctx.traceId,
        ),
      },
    }));
  });

  for (const action of ["enable", "disable"] as const) {
    app.post(`/api/v1/job-sources/:id/${action}`, (req, reply) => {
      d.guard.requireSession(req);
      const { id } = parseBody(IdParams, req.params);
      return idempotent(d.store.idempotency, req, reply, null, () => ({
        statusCode: 200,
        body: { source: d.store.jobSources.setEnabled(id, action === "enable") },
      }));
    });
  }

  /** Queues one discovery task per enabled source; the worker runs them. Sources already running are skipped. */
  app.post("/api/v1/discovery", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(RunDiscovery, req.body ?? {});
    return idempotent(d.store.idempotency, req, reply, body, () => {
      const wanted = new Set(body.sourceIds ?? []);
      const sources = d.store.jobSources
        .list()
        .filter((s) => s.enabled && (wanted.size === 0 || wanted.has(s.id)));
      const queued: { sourceId: string; taskId: string }[] = [];
      const alreadyRunning: string[] = [];
      for (const s of sources) {
        if (d.store.tasks.hasActive(keyPrefix(s.id))) {
          alreadyRunning.push(s.id);
          continue;
        }
        const t = d.store.tasks.enqueue(
          DISCOVER_SOURCE_TASK,
          { sourceId: s.id, traceId: req.ctx.traceId },
          `${keyPrefix(s.id)}${req.ctx.traceId}`,
        );
        queued.push({ sourceId: s.id, taskId: t.id });
      }
      return { statusCode: 202, body: { queued, alreadyRunning } };
    });
  });

  app.get("/api/v1/discovery/tasks", (req) => {
    d.guard.requireSession(req);
    return {
      tasks: d.store.tasks.listRecent(DISCOVER_SOURCE_TASK, 50).map((t) => ({
        id: t.id,
        sourceId: (t.payload as { sourceId?: string }).sourceId ?? null,
        status: t.status,
        attempts: t.attempts,
        lastErrorClass: t.lastErrorClass,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  });

  app.get("/api/v1/jobs", (req) => {
    d.guard.requireSession(req);
    const q = parseBody(ListJobs, req.query);
    const { items, total } = d.store.jobs.list({
      limit: q.limit,
      offset: q.offset,
      ...(q.status ? { statuses: q.status } : {}),
      ...(q.q ? { search: q.q } : {}),
      ...(q.sourceId ? { jobSourceId: q.sourceId } : {}),
      sort: q.sort,
    });
    const matches = d.store.matches.latestForJobs(items.map((j) => j.id));
    const isStale = d.matching.staleChecker(d.ownerId);
    // The list omits descriptions; open a job for details.
    return {
      total,
      jobs: items.map((j) => {
        const { descriptionText, descriptionHtmlSanitized, ...rest } = j;
        const m = matches.get(j.id);
        return {
          ...rest,
          match: m
            ? { total: m.total, verdict: m.verdict, mode: m.meta.mode, stale: isStale(j, m) }
            : null,
        };
      }),
    };
  });

  app.get("/api/v1/jobs/detail", (req) => {
    d.guard.requireSession(req);
    const { id } = parseBody(JobIdQuery, req.query);
    const job = d.store.jobs.get(id);
    if (!job) throw new NotFoundError("Job not found.");
    return { job };
  });

  app.post("/api/v1/jobs/status", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(SetStatus, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 200,
      body: { job: d.discovery.setStatus(body.id, body.to, req.ctx.traceId) },
    }));
  });

  app.post(
    "/api/v1/jobs/import",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    (req, reply) => {
      d.guard.requireSession(req);
      const body = parseBody(ImportUrl, req.body);
      return idempotent(d.store.idempotency, req, reply, body, async () => {
        const r = await d.discovery.importUrl(
          d.ownerId,
          body.url,
          body.allowGenericReader,
          req.ctx.traceId,
        );
        return { statusCode: r.created ? 201 : 200, body: r };
      });
    },
  );
}
