import { and, desc, eq, isNull } from "drizzle-orm";
import {
  NotFoundError,
  uuidv7,
  type BrowserSessionRecord,
  type BrowserSessionRepository,
  type BrowserSessionStatus,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { browserSessions } from "../schema.js";
import { toIso, toIsoOrNull, type Clock } from "../time.js";

/** Never stores query strings or fragments: they can carry tokens. */
const stripUrl = (u: string | null): string | null => {
  if (u === null) return null;
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
};

export class SqliteBrowserSessionRepository implements BrowserSessionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  start(
    applicationId: string,
    input: { adapter: string; originAllowlist: readonly string[] },
  ): BrowserSessionRecord {
    const id = uuidv7();
    this.db
      .insert(browserSessions)
      .values({
        id,
        applicationId,
        status: "active",
        adapter: input.adapter,
        originAllowlist: [...input.originAllowlist],
        startedAt: this.now(),
      })
      .run();
    return this.get(id);
  }

  update(
    id: string,
    patch: Partial<Pick<BrowserSessionRecord, "status" | "handoffReason" | "steps" | "lastUrl">>,
  ): BrowserSessionRecord {
    this.db
      .update(browserSessions)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.handoffReason !== undefined
          ? { handoffReason: patch.handoffReason?.slice(0, 500) ?? null }
          : {}),
        ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
        ...(patch.lastUrl !== undefined ? { lastUrl: stripUrl(patch.lastUrl) } : {}),
      })
      .where(eq(browserSessions.id, id))
      .run();
    return this.get(id);
  }

  end(id: string, status: "closed" | "failed"): void {
    this.db
      .update(browserSessions)
      .set({ status, endedAt: this.now() })
      .where(and(eq(browserSessions.id, id), isNull(browserSessions.endedAt)))
      .run();
  }

  latest(applicationId: string): BrowserSessionRecord | null {
    const row = this.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.applicationId, applicationId))
      .orderBy(desc(browserSessions.startedAt), desc(browserSessions.id))
      .get();
    return row ? this.toRecord(row) : null;
  }

  endAllOpen(): number {
    return this.db
      .update(browserSessions)
      .set({ status: "closed", endedAt: this.now() })
      .where(isNull(browserSessions.endedAt))
      .run().changes;
  }

  private get(id: string): BrowserSessionRecord {
    const row = this.db.select().from(browserSessions).where(eq(browserSessions.id, id)).get();
    if (!row) throw new NotFoundError("Browser session not found.");
    return this.toRecord(row);
  }

  private toRecord(row: typeof browserSessions.$inferSelect): BrowserSessionRecord {
    return {
      id: row.id,
      applicationId: row.applicationId ?? "",
      status: row.status as BrowserSessionStatus,
      adapter: row.adapter,
      originAllowlist: row.originAllowlist,
      handoffReason: row.handoffReason,
      steps: row.steps,
      lastUrl: row.lastUrl,
      startedAt: toIso(row.startedAt),
      endedAt: toIsoOrNull(row.endedAt),
    };
  }
}
