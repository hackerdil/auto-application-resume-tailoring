import { and, desc, eq } from "drizzle-orm";
import {
  Application,
  assertApplicationTransition,
  ConflictError,
  NotFoundError,
  uuidv7,
  type ApplicationRepository,
  type ApplicationState,
  type ApplicationTransitionContext,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { mapConstraintError } from "../errors.js";
import { applications } from "../schema.js";
import { toIso, type Clock } from "../time.js";
import { emptyAudit, insertAudit } from "./shared.js";

type Row = typeof applications.$inferSelect;

const toDomain = (r: Row): Application =>
  Application.parse({ ...r, createdAt: toIso(r.createdAt), updatedAt: toIso(r.updatedAt) });

export class SqliteApplicationRepository implements ApplicationRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(userId: string, jobId: string, traceId: string): Application {
    return this.db.transaction(
      (tx) => {
        const id = uuidv7();
        const now = this.now();
        try {
          tx.insert(applications)
            .values({ id, userId, jobId, state: "DRAFT", createdAt: now, updatedAt: now })
            .run();
        } catch (err) {
          mapConstraintError(err, "An application for this job already exists.");
        }
        insertAudit(
          tx,
          {
            ...emptyAudit,
            traceId,
            actor: "user",
            type: "application.created",
            applicationId: id,
            jobId,
            newState: "DRAFT",
          },
          this.now,
        );
        return toDomain({
          id,
          userId,
          jobId,
          state: "DRAFT",
          resumeVersionId: null,
          coverLetterVersionId: null,
          coverLetterSkipped: false,
          createdAt: now,
          updatedAt: now,
        });
      },
      { behavior: "immediate" },
    );
  }

  get(id: string): Application | null {
    const row = this.db.select().from(applications).where(eq(applications.id, id)).get();
    return row ? toDomain(row) : null;
  }

  findForJob(userId: string, jobId: string): Application | null {
    const row = this.db
      .select()
      .from(applications)
      .where(and(eq(applications.userId, userId), eq(applications.jobId, jobId)))
      .get();
    return row ? toDomain(row) : null;
  }

  list(userId: string): Application[] {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.userId, userId))
      .orderBy(desc(applications.updatedAt), desc(applications.id))
      .all()
      .map(toDomain);
  }

  setMaterials(
    id: string,
    m: {
      resumeVersionId?: string | null;
      coverLetterVersionId?: string | null;
      coverLetterSkipped?: boolean;
    },
  ): Application {
    const set: Partial<Row> = { updatedAt: this.now() };
    if (m.resumeVersionId !== undefined) set.resumeVersionId = m.resumeVersionId;
    if (m.coverLetterVersionId !== undefined) set.coverLetterVersionId = m.coverLetterVersionId;
    if (m.coverLetterSkipped !== undefined) set.coverLetterSkipped = m.coverLetterSkipped;
    this.db.update(applications).set(set).where(eq(applications.id, id)).run();
    const app = this.get(id);
    if (!app) throw new NotFoundError("Application not found.");
    return app;
  }

  /**
   * Guarded transition + audit event in one IMMEDIATE transaction. The UPDATE is conditional on the
   * state we read, so a concurrent writer causes a ConflictError instead of a lost update.
   */
  transition(
    id: string,
    to: ApplicationState,
    ctx: ApplicationTransitionContext & {
      traceId: string;
      approvalId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Application {
    return this.db.transaction(
      (tx) => {
        const row = tx.select().from(applications).where(eq(applications.id, id)).get();
        if (!row) throw new NotFoundError("Application not found.");
        const from = row.state as ApplicationState;
        assertApplicationTransition(from, to, ctx);
        const now = this.now();
        const res = tx
          .update(applications)
          .set({ state: to, updatedAt: now })
          .where(and(eq(applications.id, id), eq(applications.state, from)))
          .run();
        if (res.changes !== 1)
          throw new ConflictError(
            "Application changed concurrently; retry from the current state.",
          );
        insertAudit(
          tx,
          {
            ...emptyAudit,
            traceId: ctx.traceId,
            actor: ctx.actor,
            type: "application.transition",
            applicationId: id,
            jobId: row.jobId,
            prevState: from,
            newState: to,
            approvalId: ctx.approvalId ?? null,
            metadata: { mode: ctx.mode, ...(ctx.metadata ?? {}) },
          },
          this.now,
        );
        return toDomain({ ...row, state: to, updatedAt: now });
      },
      { behavior: "immediate" },
    );
  }
}
