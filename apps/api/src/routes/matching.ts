import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NotFoundError,
  SCORE_JOB_TASK,
  scoreKeyPrefix,
  type MatchingService,
} from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const ScoreBody = z.object({ ids: z.array(z.string().min(3).max(400)).max(200).optional() });
const JobIdQuery = z.object({ id: z.string().min(3).max(400) });

export function registerMatchingRoutes(
  app: FastifyInstance,
  d: {
    guard: LocalGuard;
    store: Store;
    ownerId: string;
    matching: MatchingService;
    maxJobsScoredPerRun: number;
  },
) {
  /**
   * Queues scoring for the given jobs, or for every eligible/scored job (up to MAX_JOBS_SCORED_PER_RUN).
   * The worker does the scoring; jobs already queued are skipped.
   */
  app.post("/api/v1/jobs/score", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(ScoreBody, req.body ?? {});
    return idempotent(d.store.idempotency, req, reply, body, () => {
      const ids =
        body.ids ??
        d.store.jobs
          .list({
            statuses: ["ELIGIBLE", "SCORED", "SHORTLISTED"],
            limit: d.maxJobsScoredPerRun,
            offset: 0,
          })
          .items.map((j) => j.id);
      const queued: string[] = [];
      const skipped: string[] = [];
      for (const id of ids.slice(0, d.maxJobsScoredPerRun)) {
        const job = d.store.jobs.get(id);
        if (
          !job ||
          !["ELIGIBLE", "SCORED", "SHORTLISTED", "SKIPPED"].includes(job.status) ||
          d.store.tasks.hasActive(scoreKeyPrefix(id))
        ) {
          skipped.push(id);
          continue;
        }
        d.store.tasks.enqueue(
          SCORE_JOB_TASK,
          { jobId: id, traceId: req.ctx.traceId },
          `${scoreKeyPrefix(id)}${req.ctx.traceId}`,
        );
        queued.push(id);
      }
      return { statusCode: 202, body: { queued, skipped, limit: d.maxJobsScoredPerRun } };
    });
  });

  app.get("/api/v1/jobs/match", (req) => {
    d.guard.requireSession(req);
    const { id } = parseBody(JobIdQuery, req.query);
    const job = d.store.jobs.get(id);
    if (!job) throw new NotFoundError("Job not found.");
    const match = d.store.matches.latestForJob(id);
    if (!match)
      return {
        match: null,
        stale: false,
        facts: {},
        scoring: d.store.tasks.hasActive(scoreKeyPrefix(id)),
      };
    const cited = new Set(match.requirements.flatMap((r) => r.factIds));
    const facts: Record<string, { claim: string; category: string; source: string }> = {};
    for (const fid of cited) {
      const f = d.store.facts.get(fid);
      if (f) facts[fid] = { claim: f.claim, category: f.category, source: f.source };
    }
    return {
      match,
      stale: d.matching.isStale(d.ownerId, job, match),
      facts,
      scoring: d.store.tasks.hasActive(scoreKeyPrefix(id)),
    };
  });
}
