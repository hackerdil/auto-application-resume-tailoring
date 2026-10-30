import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  assertJobTransition,
  Job,
  NotFoundError,
  uuidv7,
  type AuditEvent,
  type JobListQuery,
  type JobRepository,
  type JobStatus,
  type UpsertJobResult,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { companies, jobs } from "../schema.js";
import { fromIso, type Clock } from "../time.js";
import { emptyAudit, insertAudit, type Executor } from "./shared.js";

const normalizeCompany = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|plc|corp|co|bv|ag|sa)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export class SqliteJobRepository implements JobRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /**
   * Dedupes on the canonical ID. Status, firstSeenAt and filter reasons of an existing job are preserved;
   * content changes are detected by contentHash. A job listed again is no longer "removed".
   */
  upsert(input: Job, jobSourceId: string | null = null): UpsertJobResult {
    const job = Job.parse(input);
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        const companyId = this.companyId(tx, job.company, now);
        const existing = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
        if (!existing) {
          tx.insert(jobs)
            .values({
              id: job.id,
              source: job.source,
              externalId: job.externalId,
              companyId,
              jobSourceId,
              data: job,
              status: job.status,
              sourceHash: job.sourceHash,
              contentHash: job.contentHash,
              firstSeenAt: fromIso(job.firstSeenAt),
              lastSeenAt: fromIso(job.lastSeenAt),
              createdAt: now,
              updatedAt: now,
            })
            .run();
          return { job, outcome: "created" as const };
        }
        const prev = Job.parse(existing.data);
        const merged: Job = {
          ...job,
          status: prev.status,
          firstSeenAt: prev.firstSeenAt,
          filterReasons: prev.filterReasons,
          removedFromSourceAt: null,
        };
        const changed = existing.contentHash !== job.contentHash;
        tx.update(jobs)
          .set({
            data: merged,
            companyId,
            jobSourceId: jobSourceId ?? existing.jobSourceId,
            sourceHash: job.sourceHash,
            contentHash: job.contentHash,
            lastSeenAt: Math.max(existing.lastSeenAt, fromIso(job.lastSeenAt)),
            updatedAt: now,
          })
          .where(eq(jobs.id, job.id))
          .run();
        return { job: merged, outcome: changed ? ("updated" as const) : ("unchanged" as const) };
      },
      { behavior: "immediate" },
    );
  }

  get(id: string): Job | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? Job.parse({ ...row.data, status: row.status }) : null;
  }

  transition(
    id: string,
    to: JobStatus,
    audit: { traceId: string; actor: AuditEvent["actor"] },
    patch: { filterReasons?: string[] } = {},
  ): Job {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(jobs).where(eq(jobs.id, id)).get();
        if (!row) throw new NotFoundError("Job not found.");
        const from = row.status as JobStatus;
        assertJobTransition(from, to);
        const job = Job.parse({
          ...row.data,
          status: to,
          ...(patch.filterReasons ? { filterReasons: patch.filterReasons } : {}),
        });
        tx.update(jobs)
          .set({ status: to, data: job, updatedAt: this.now() })
          .where(eq(jobs.id, id))
          .run();
        insertAudit(
          tx,
          {
            ...emptyAudit,
            traceId: audit.traceId,
            actor: audit.actor,
            type: "job.transition",
            jobId: id,
            prevState: from,
            newState: to,
            metadata: patch.filterReasons ? { filterReasons: patch.filterReasons } : {},
          },
          this.now,
        );
        return job;
      },
      { behavior: "immediate" },
    );
  }

  list(q: JobListQuery): { items: Job[]; total: number } {
    const conds: SQL[] = [];
    if (q.statuses?.length) conds.push(inArray(jobs.status, q.statuses));
    if (q.jobSourceId) conds.push(eq(jobs.jobSourceId, q.jobSourceId));
    const term = q.search?.trim().toLowerCase();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const cond = or(
        sql`lower(json_extract(${jobs.data}, '$.title')) LIKE ${like} ESCAPE '\\'`,
        sql`lower(json_extract(${jobs.data}, '$.company')) LIKE ${like} ESCAPE '\\'`,
      );
      if (cond) conds.push(cond);
    }
    const where = conds.length ? and(...conds) : undefined;
    const total =
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(jobs)
        .where(where)
        .get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(
        ...(q.sort === "score"
          ? [
              sql`(SELECT m.total FROM match_results m WHERE m.job_id = ${jobs.id} ORDER BY m.created_at DESC LIMIT 1) DESC NULLS LAST`,
            ]
          : []),
        desc(jobs.firstSeenAt),
        desc(jobs.id),
      )
      .limit(Math.min(Math.max(q.limit, 1), 200))
      .offset(Math.max(q.offset, 0))
      .all();
    return { items: rows.map((r) => Job.parse({ ...r.data, status: r.status })), total };
  }

  findByContentHash(contentHash: string, excludeId: string): Job[] {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.contentHash, contentHash), ne(jobs.id, excludeId)))
      .all()
      .map((r) => Job.parse({ ...r.data, status: r.status }));
  }

  markRemoved(jobSourceId: string, listedIds: readonly string[], at: string): number {
    const res = this.db.run(sql`
      UPDATE jobs
         SET data = json_set(data, '$.removedFromSourceAt', ${at}), updated_at = ${this.now()}
       WHERE job_source_id = ${jobSourceId}
         AND json_extract(data, '$.removedFromSourceAt') IS NULL
         AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(listedIds)}))`);
    return res.changes;
  }

  private companyId(ex: Executor, name: string, now: number): string | null {
    const normalizedName = normalizeCompany(name);
    if (!normalizedName) return null;
    const existing = ex
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.normalizedName, normalizedName))
      .get();
    if (existing) return existing.id;
    const id = uuidv7();
    ex.insert(companies).values({ id, name: name.trim(), normalizedName, createdAt: now }).run();
    return id;
  }
}
