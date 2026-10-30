import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { ConflictError, uuidv7, type TaskRecord, type TaskRepository } from "@career-agent/domain";
import type { Db } from "../database.js";
import { tasks } from "../schema.js";
import { toIso, toIsoOrNull, type Clock } from "../time.js";

type Row = typeof tasks.$inferSelect;

const toRecord = (r: Row): TaskRecord => ({
  id: r.id,
  kind: r.kind,
  payload: r.payload,
  idempotencyKey: r.idempotencyKey,
  status: r.status as TaskRecord["status"],
  attempts: r.attempts,
  leaseOwner: r.leaseOwner,
  leaseExpiresAt: toIsoOrNull(r.leaseExpiresAt),
});

/** Resumable work queue with leases (ADR-012). */
export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
    private readonly backoffMs: (attempt: number) => number = (a) =>
      Math.min(60_000, 1_000 * 2 ** a),
  ) {}

  enqueue(kind: string, payload: unknown, idempotencyKey: string): TaskRecord {
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(tasks)
          .where(eq(tasks.idempotencyKey, idempotencyKey))
          .get();
        if (existing) return toRecord(existing);
        const now = this.now();
        const row: Row = {
          id: uuidv7(),
          kind,
          payload,
          idempotencyKey,
          status: "queued",
          attempts: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          availableAt: now,
          lastErrorClass: null,
          createdAt: now,
          updatedAt: now,
        };
        tx.insert(tasks).values(row).run();
        return toRecord(row);
      },
      { behavior: "immediate" },
    );
  }

  claim(workerId: string, leaseMs: number): TaskRecord | null {
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        const candidate = tx
          .select()
          .from(tasks)
          .where(
            or(
              and(eq(tasks.status, "queued"), lte(tasks.availableAt, now)),
              and(eq(tasks.status, "leased"), lt(tasks.leaseExpiresAt, now)),
            ),
          )
          .orderBy(asc(tasks.availableAt), asc(tasks.id))
          .limit(1)
          .get();
        if (!candidate) return null;
        const updated: Row = {
          ...candidate,
          status: "leased",
          leaseOwner: workerId,
          leaseExpiresAt: now + leaseMs,
          attempts: candidate.attempts + 1,
          updatedAt: now,
        };
        tx.update(tasks)
          .set({
            status: updated.status,
            leaseOwner: updated.leaseOwner,
            leaseExpiresAt: updated.leaseExpiresAt,
            attempts: updated.attempts,
            updatedAt: now,
          })
          .where(eq(tasks.id, candidate.id))
          .run();
        return toRecord(updated);
      },
      { behavior: "immediate" },
    );
  }

  complete(id: string, workerId: string): void {
    this.finish(id, workerId, { status: "done" });
  }

  fail(
    id: string,
    workerId: string,
    opts: { retry: boolean; maxAttempts: number; errorClass?: string },
  ): void {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) return;
    const lastErrorClass = opts.errorClass ?? null;
    if (opts.retry && row.attempts < opts.maxAttempts) {
      this.finish(id, workerId, {
        status: "queued",
        availableAt: this.now() + this.backoffMs(row.attempts),
        lastErrorClass,
      });
    } else {
      this.finish(id, workerId, { status: "failed", lastErrorClass });
    }
  }

  get(id: string): TaskRecord | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? toRecord(row) : null;
  }

  listRecent(kind: string, limit: number) {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, kind))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map((r) => ({
        ...toRecord(r),
        createdAt: toIso(r.createdAt),
        updatedAt: toIso(r.updatedAt),
        lastErrorClass: r.lastErrorClass,
      }));
  }

  hasActive(prefix: string): boolean {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return !!this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ["queued", "leased"]),
          sql`${tasks.idempotencyKey} LIKE ${`${escaped}%`} ESCAPE '\\'`,
        ),
      )
      .get();
  }

  /** Used for ambiguous submissions: the task is parked until a human resolves it and is never re-leased. */
  markNeedsHuman(id: string, workerId: string): void {
    this.finish(id, workerId, { status: "needs_human" });
  }

  private finish(
    id: string,
    workerId: string,
    set: Partial<Pick<Row, "status" | "availableAt" | "lastErrorClass">>,
  ): void {
    const res = this.db
      .update(tasks)
      .set({ ...set, leaseOwner: null, leaseExpiresAt: null, updatedAt: this.now() })
      .where(and(eq(tasks.id, id), eq(tasks.leaseOwner, workerId), eq(tasks.status, "leased")))
      .run();
    if (res.changes !== 1) throw new ConflictError("Task lease is not held by this worker.");
  }
}
