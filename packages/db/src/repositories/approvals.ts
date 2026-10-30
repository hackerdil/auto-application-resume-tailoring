import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  ConflictError,
  type ApprovalRecord,
  type ApprovalRepository,
  type SubmissionAttemptRecord,
  type SubmissionAttemptRepository,
  type SubmissionEvidence,
  type SubmissionOutcome,
  uuidv7,
  NotFoundError,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { applicationApprovals, submissionAttempts } from "../schema.js";
import { fromIso, toIso, toIsoOrNull, type Clock } from "../time.js";

/**
 * Single-use approvals (docs/APPROVAL_MODEL.md). Only the token's SHA-256 is stored. Triggers make consumed or
 * revoked rows immutable, and a partial unique index allows one active approval per application.
 */
export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  issue(input: Omit<ApprovalRecord, "consumedAt" | "revokedAt" | "revokeReason">): ApprovalRecord {
    return this.db.transaction(
      (tx) => {
        tx.update(applicationApprovals)
          .set({ revokedAt: this.now(), revokeReason: "superseded" })
          .where(
            and(
              eq(applicationApprovals.applicationId, input.applicationId),
              isNull(applicationApprovals.consumedAt),
              isNull(applicationApprovals.revokedAt),
            ),
          )
          .run();
        tx.insert(applicationApprovals)
          .values({
            id: input.id,
            applicationId: input.applicationId,
            tokenHash: input.tokenHash,
            bindingJson: input.bindingJson,
            bindingMac: input.bindingMac,
            issuedAt: fromIso(input.issuedAt),
            expiresAt: fromIso(input.expiresAt),
          })
          .run();
        const row = tx
          .select()
          .from(applicationApprovals)
          .where(eq(applicationApprovals.id, input.id))
          .get();
        if (!row) throw new ConflictError("Approval was not stored.");
        return toRecord(row);
      },
      { behavior: "immediate" },
    );
  }

  get(id: string): ApprovalRecord | null {
    const row = this.db
      .select()
      .from(applicationApprovals)
      .where(eq(applicationApprovals.id, id))
      .get();
    return row ? toRecord(row) : null;
  }

  active(applicationId: string): ApprovalRecord | null {
    const row = this.db
      .select()
      .from(applicationApprovals)
      .where(
        and(
          eq(applicationApprovals.applicationId, applicationId),
          isNull(applicationApprovals.consumedAt),
          isNull(applicationApprovals.revokedAt),
        ),
      )
      .get();
    return row ? toRecord(row) : null;
  }

  revoke(id: string, reason: string): boolean {
    return (
      this.db
        .update(applicationApprovals)
        .set({ revokedAt: this.now(), revokeReason: reason.slice(0, 200) })
        .where(
          and(
            eq(applicationApprovals.id, id),
            isNull(applicationApprovals.consumedAt),
            isNull(applicationApprovals.revokedAt),
          ),
        )
        .run().changes === 1
    );
  }

  revokeAllActive(applicationId: string, reason: string): number {
    return this.db
      .update(applicationApprovals)
      .set({ revokedAt: this.now(), revokeReason: reason.slice(0, 200) })
      .where(
        and(
          eq(applicationApprovals.applicationId, applicationId),
          isNull(applicationApprovals.consumedAt),
          isNull(applicationApprovals.revokedAt),
        ),
      )
      .run().changes;
  }

  consume(id: string, nowIso: string): boolean {
    const now = fromIso(nowIso);
    const res = this.db
      .update(applicationApprovals)
      .set({ consumedAt: now })
      .where(
        and(
          eq(applicationApprovals.id, id),
          isNull(applicationApprovals.consumedAt),
          isNull(applicationApprovals.revokedAt),
          gt(applicationApprovals.expiresAt, now),
        ),
      )
      .run();
    return res.changes === 1;
  }
}

function toRecord(row: typeof applicationApprovals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    tokenHash: row.tokenHash,
    bindingJson: row.bindingJson,
    bindingMac: row.bindingMac,
    issuedAt: toIso(row.issuedAt),
    expiresAt: toIso(row.expiresAt),
    consumedAt: toIsoOrNull(row.consumedAt),
    revokedAt: toIsoOrNull(row.revokedAt),
    revokeReason: row.revokeReason,
  };
}

export class SqliteSubmissionAttemptRepository implements SubmissionAttemptRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  start(applicationId: string, approvalId: string): SubmissionAttemptRecord {
    const id = uuidv7();
    this.db
      .insert(submissionAttempts)
      .values({ id, applicationId, approvalId, startedAt: this.now() })
      .run();
    return this.get(id);
  }

  finish(
    id: string,
    outcome: SubmissionOutcome,
    evidence: SubmissionEvidence,
  ): SubmissionAttemptRecord {
    this.db
      .update(submissionAttempts)
      .set({
        outcome,
        evidence: evidence as unknown as Record<string, unknown>,
        endedAt: this.now(),
      })
      .where(eq(submissionAttempts.id, id))
      .run();
    return this.get(id);
  }

  latest(applicationId: string): SubmissionAttemptRecord | null {
    const row = this.db
      .select()
      .from(submissionAttempts)
      .where(eq(submissionAttempts.applicationId, applicationId))
      .orderBy(desc(submissionAttempts.startedAt), desc(submissionAttempts.id))
      .get();
    return row ? attempt(row) : null;
  }

  private get(id: string): SubmissionAttemptRecord {
    const row = this.db
      .select()
      .from(submissionAttempts)
      .where(eq(submissionAttempts.id, id))
      .get();
    if (!row) throw new NotFoundError("Submission attempt not found.");
    return attempt(row);
  }
}

function attempt(row: typeof submissionAttempts.$inferSelect): SubmissionAttemptRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    approvalId: row.approvalId,
    startedAt: toIso(row.startedAt),
    endedAt: toIsoOrNull(row.endedAt),
    outcome: (row.outcome as SubmissionOutcome | null) ?? null,
    evidence: (row.evidence as SubmissionEvidence | null) ?? null,
  };
}
