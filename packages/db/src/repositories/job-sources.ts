import { and, desc, eq, inArray } from "drizzle-orm";
import {
  JobSourceType,
  NotFoundError,
  uuidv7,
  type JobFetchRecord,
  type JobFetchRepository,
  type JobSourceRecord,
  type JobSourceRepository,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { mapConstraintError } from "../errors.js";
import { jobFetches, jobSources } from "../schema.js";
import { fromIso, toIso, type Clock } from "../time.js";

type SourceRow = typeof jobSources.$inferSelect;
type FetchRow = typeof jobFetches.$inferSelect;

const toSource = (r: SourceRow): JobSourceRecord => ({
  id: r.id,
  type: JobSourceType.parse(r.type),
  identifier: r.identifier,
  displayName: typeof r.config["displayName"] === "string" ? r.config["displayName"] : null,
  enabled: r.enabled,
  allowedHosts: r.originAllowlist,
  createdAt: toIso(r.createdAt),
});

const toFetch = (r: FetchRow): JobFetchRecord => ({
  ...r,
  fetchedAt: toIso(r.fetchedAt),
  outcome: r.outcome as JobFetchRecord["outcome"],
});

export class SqliteJobSourceRepository implements JobSourceRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  add(input: Omit<JobSourceRecord, "id" | "createdAt" | "enabled">): JobSourceRecord {
    const row: SourceRow = {
      id: uuidv7(),
      type: input.type,
      identifier: input.identifier,
      enabled: true,
      config: input.displayName ? { displayName: input.displayName } : {},
      originAllowlist: [...input.allowedHosts],
      createdAt: this.now(),
    };
    try {
      this.db.insert(jobSources).values(row).run();
    } catch (err) {
      mapConstraintError(err, "This job source is already configured.");
    }
    return toSource(row);
  }

  get(id: string): JobSourceRecord | null {
    const r = this.db.select().from(jobSources).where(eq(jobSources.id, id)).get();
    return r ? toSource(r) : null;
  }

  list(): JobSourceRecord[] {
    return this.db
      .select()
      .from(jobSources)
      .orderBy(jobSources.type, jobSources.identifier)
      .all()
      .map(toSource);
  }

  setEnabled(id: string, enabled: boolean): JobSourceRecord {
    this.db.update(jobSources).set({ enabled }).where(eq(jobSources.id, id)).run();
    const s = this.get(id);
    if (!s) throw new NotFoundError("Job source not found.");
    return s;
  }
}

export class SqliteJobFetchRepository implements JobFetchRepository {
  constructor(private readonly db: Db) {}

  record(f: Omit<JobFetchRecord, "id">): JobFetchRecord {
    const row: FetchRow = { ...f, id: uuidv7(), fetchedAt: fromIso(f.fetchedAt) };
    this.db.insert(jobFetches).values(row).run();
    return toFetch(row);
  }

  latestForSource(jobSourceId: string): JobFetchRecord | null {
    const r = this.db
      .select()
      .from(jobFetches)
      .where(eq(jobFetches.jobSourceId, jobSourceId))
      .orderBy(desc(jobFetches.fetchedAt), desc(jobFetches.id))
      .limit(1)
      .get();
    return r ? toFetch(r) : null;
  }

  latestSuccessForSource(jobSourceId: string): JobFetchRecord | null {
    const r = this.db
      .select()
      .from(jobFetches)
      .where(
        and(
          eq(jobFetches.jobSourceId, jobSourceId),
          inArray(jobFetches.outcome, ["ok", "not_modified"]),
        ),
      )
      .orderBy(desc(jobFetches.fetchedAt), desc(jobFetches.id))
      .limit(1)
      .get();
    return r ? toFetch(r) : null;
  }
}
