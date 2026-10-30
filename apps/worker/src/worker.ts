import type { Store } from "@career-agent/db";
import {
  DISCOVER_SOURCE_TASK,
  SCORE_JOB_TASK,
  scoreKeyPrefix,
  TAILOR_RESUME_TASK,
  DRAFT_COVER_LETTER_TASK,
  PREPARE_APPLICATION_TASK,
  CLOSE_BROWSER_TASK,
  type ApplicationService,
  type DiscoveryService,
  type MatchingService,
  type TailoringService,
  type TaskRecord,
} from "@career-agent/domain";
import { newTraceId, type Logger } from "@career-agent/observability";
import type { BrowserPreparer } from "./preparer.js";

export const MAX_DISCOVERY_ATTEMPTS = 3;

export interface WorkerDeps {
  store: Store;
  discovery: DiscoveryService;
  matching: MatchingService;
  tailoring?: TailoringService;
  applications?: ApplicationService;
  /** Phase 7: the visible preparation browsers this worker owns. */
  preparer?: BrowserPreparer;
  ownerId: string;
  workerId: string;
  logger: Logger;
  /** MAX_JOBS_SCORED_PER_RUN: cap on scoring tasks queued after one discovery run. */
  maxJobsScoredPerRun: number;
  leaseMs?: number;
}

/**
 * Queues scoring for eligible jobs, at most `limit`. The key includes the job's content hash, so unchanged jobs
 * are not re-scored by discovery; explicit re-scoring uses its own key.
 */
export function enqueueScoring(
  store: Store,
  jobIds: readonly string[],
  traceId: string,
  limit: number,
  keySuffix?: string,
): string[] {
  const queued: string[] = [];
  for (const id of jobIds) {
    if (queued.length >= limit) break;
    if (store.tasks.hasActive(scoreKeyPrefix(id))) continue;
    const job = store.jobs.get(id);
    if (!job) continue;
    const t = store.tasks.enqueue(
      SCORE_JOB_TASK,
      { jobId: id, traceId },
      `${scoreKeyPrefix(id)}${keySuffix ?? job.contentHash}`,
    );
    if (t.status === "queued") queued.push(id);
  }
  return queued;
}

/**
 * Resumable worker (ADR-012): claims one leased task at a time. A crash leaves the lease to expire and another
 * worker (or a restart) picks the task up again. Failures are classified; only transient ones are retried.
 */
export class Worker {
  constructor(private readonly d: WorkerDeps) {}

  /** Processes at most one task; returns false when the queue was empty. */
  async tick(signal?: AbortSignal): Promise<boolean> {
    const task = this.d.store.tasks.claim(this.d.workerId, this.d.leaseMs ?? 5 * 60_000);
    if (!task) return false;
    const log = this.d.logger.child({ taskId: task.id, kind: task.kind, attempt: task.attempts });
    try {
      if (task.kind === DISCOVER_SOURCE_TASK) await this.discover(task, log, signal);
      else if (task.kind === SCORE_JOB_TASK) await this.score(task, log);
      else if (task.kind === TAILOR_RESUME_TASK) await this.tailor(task, log);
      else if (task.kind === DRAFT_COVER_LETTER_TASK) await this.coverLetter(task, log);
      else if (task.kind === PREPARE_APPLICATION_TASK) await this.prepare(task, log);
      else if (task.kind === CLOSE_BROWSER_TASK) await this.closeBrowser(task);
      else {
        log.error("unknown task kind");
        this.d.store.tasks.fail(task.id, this.d.workerId, {
          retry: false,
          maxAttempts: 1,
          errorClass: "unknown_task",
        });
      }
    } catch (err) {
      log.error({ err }, "task crashed");
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: false,
        maxAttempts: 1,
        errorClass: "crash",
      });
    }
    return true;
  }

  private async discover(task: TaskRecord, log: Logger, signal?: AbortSignal): Promise<void> {
    const payload = task.payload as { sourceId?: unknown; traceId?: unknown };
    if (typeof payload.sourceId !== "string")
      throw new Error("discover_source task without sourceId");
    const traceId = typeof payload.traceId === "string" ? payload.traceId : newTraceId();
    const summary = await this.d.discovery.runSource(
      payload.sourceId,
      this.d.ownerId,
      traceId,
      signal,
    );
    if (summary.outcome === "error") {
      log.warn({ errorClass: summary.error?.errorClass }, "discovery source failed");
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: summary.error?.retryable ?? false,
        maxAttempts: MAX_DISCOVERY_ATTEMPTS,
        errorClass: summary.error?.errorClass ?? "error",
      });
      return;
    }
    const eligible = this.d.store.jobs
      .list({
        statuses: ["ELIGIBLE"],
        jobSourceId: payload.sourceId,
        limit: this.d.maxJobsScoredPerRun,
        offset: 0,
      })
      .items.map((j) => j.id);
    const queued = enqueueScoring(this.d.store, eligible, traceId, this.d.maxJobsScoredPerRun);
    log.info(
      {
        outcome: summary.outcome,
        listed: summary.listed,
        created: summary.created,
        removed: summary.removed,
        scoringQueued: queued.length,
      },
      "discovery source done",
    );
    this.d.store.tasks.complete(task.id, this.d.workerId);
  }

  private async score(task: TaskRecord, log: Logger): Promise<void> {
    const payload = task.payload as { jobId?: unknown; traceId?: unknown };
    if (typeof payload.jobId !== "string") throw new Error("score_job task without jobId");
    const traceId = typeof payload.traceId === "string" ? payload.traceId : newTraceId();
    try {
      const m = await this.d.matching.scoreJob(payload.jobId, this.d.ownerId, traceId);
      log.info({ total: m.total, verdict: m.verdict, mode: m.meta.mode }, "job scored");
      this.d.store.tasks.complete(task.id, this.d.workerId);
    } catch (err) {
      const errorClass =
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code.toLowerCase()
          : "error";
      log.warn({ errorClass }, "scoring failed");
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: false,
        maxAttempts: 1,
        errorClass,
      });
    }
  }

  private async tailor(task: TaskRecord, log: Logger): Promise<void> {
    const payload = task.payload as { jobId?: unknown; length?: unknown; traceId?: unknown };
    if (typeof payload.jobId !== "string") throw new Error("tailor_resume task without jobId");
    const length = payload.length === "full" ? "full" : "one-page";
    const traceId = typeof payload.traceId === "string" ? payload.traceId : newTraceId();
    try {
      if (!this.d.tailoring) throw new Error("tailoring is not configured in this worker");
      const rec = await this.d.tailoring.tailor(payload.jobId, this.d.ownerId, length, traceId);
      log.info(
        { resumeId: rec.resume.id, status: rec.status, dropped: rec.resume.dropped.length },
        "résumé tailored",
      );
      this.d.store.tasks.complete(task.id, this.d.workerId);
    } catch (err) {
      const errorClass =
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code.toLowerCase()
          : "error";
      log.warn({ errorClass, err }, "tailoring failed");
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: false,
        maxAttempts: 1,
        errorClass,
      });
    }
  }

  private async coverLetter(task: TaskRecord, log: Logger): Promise<void> {
    const payload = task.payload as { applicationId?: unknown; traceId?: unknown };
    if (typeof payload.applicationId !== "string")
      throw new Error("draft_cover_letter task without applicationId");
    const traceId = typeof payload.traceId === "string" ? payload.traceId : newTraceId();
    try {
      if (!this.d.applications) throw new Error("applications are not configured in this worker");
      const rec = await this.d.applications.draftCoverLetter(
        this.d.ownerId,
        payload.applicationId,
        traceId,
      );
      log.info(
        { letterId: rec.letter.id, status: rec.status, dropped: rec.letter.dropped.length },
        "cover letter drafted",
      );
      this.d.store.tasks.complete(task.id, this.d.workerId);
    } catch (err) {
      const errorClass =
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code.toLowerCase()
          : "error";
      log.warn({ errorClass, err }, "cover letter drafting failed");
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: false,
        maxAttempts: 1,
        errorClass,
      });
    }
  }

  private async prepare(task: TaskRecord, log: Logger): Promise<void> {
    const payload = task.payload as { applicationId?: unknown; traceId?: unknown };
    if (typeof payload.applicationId !== "string")
      throw new Error("prepare_application task without applicationId");
    const traceId = typeof payload.traceId === "string" ? payload.traceId : newTraceId();
    try {
      if (!this.d.preparer) throw new Error("browser preparation is not configured in this worker");
      const r = await this.d.preparer.prepare(payload.applicationId, traceId);
      log.info(
        { status: r.status, filled: r.filled, refused: r.refused.length, pages: r.pages },
        "application form prepared",
      );
      this.d.store.tasks.complete(task.id, this.d.workerId);
    } catch (err) {
      const errorClass =
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code.toLowerCase()
          : "error";
      log.warn({ errorClass }, "browser preparation failed");
      const rec = this.d.store.browserSessions.latest(payload.applicationId);
      if (rec && !rec.endedAt)
        this.d.store.browserSessions.update(rec.id, {
          status: "awaiting_input",
          handoffReason:
            err instanceof Error && "code" in err
              ? err.message
              : "Preparation stopped unexpectedly.",
        });
      this.d.store.tasks.fail(task.id, this.d.workerId, {
        retry: false,
        maxAttempts: 1,
        errorClass,
      });
    }
  }

  private async closeBrowser(task: TaskRecord): Promise<void> {
    const payload = task.payload as { applicationId?: unknown };
    if (typeof payload.applicationId !== "string")
      throw new Error("close_browser task without applicationId");
    await this.d.preparer?.close(payload.applicationId);
    this.d.store.tasks.complete(task.id, this.d.workerId);
  }

  async run(signal: AbortSignal, idleMs = 2000): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.tick(signal).catch((err: unknown) => {
        this.d.logger.error({ err }, "worker tick failed");
        return false;
      });
      if (!worked) await new Promise((r) => setTimeout(r, idleMs));
    }
  }
}
