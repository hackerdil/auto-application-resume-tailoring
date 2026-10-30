import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  JobRequirement,
  MatchResult,
  uuidv7,
  type JobRequirementRepository,
  type MatchRepository,
  type ProviderRunRecord,
  type ProviderRunRepository,
  type ProviderUsageRow,
  type RequirementKind,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { jobRequirements, matchResults, providerRuns } from "../schema.js";
import { fromIso, type Clock } from "../time.js";

export class SqliteMatchRepository implements MatchRepository {
  constructor(private readonly db: Db) {}

  save(input: MatchResult): MatchResult {
    const r = MatchResult.parse(input);
    this.db
      .insert(matchResults)
      .values({
        id: r.id,
        jobId: r.jobId,
        profileVersion: r.profileVersion,
        scoringVersion: r.meta.scoringVersion,
        total: r.total,
        verdict: r.verdict,
        data: r,
        createdAt: fromIso(r.createdAt),
      })
      .onConflictDoUpdate({
        target: [matchResults.jobId, matchResults.profileVersion, matchResults.scoringVersion],
        set: {
          id: r.id,
          total: r.total,
          verdict: r.verdict,
          data: r,
          createdAt: fromIso(r.createdAt),
        },
      })
      .run();
    return r;
  }

  latestForJob(jobId: string): MatchResult | null {
    const row = this.db
      .select()
      .from(matchResults)
      .where(eq(matchResults.jobId, jobId))
      .orderBy(desc(matchResults.createdAt), desc(matchResults.id))
      .limit(1)
      .get();
    return row ? MatchResult.parse(row.data) : null;
  }

  latestForJobs(jobIds: readonly string[]): Map<string, MatchResult> {
    const out = new Map<string, MatchResult>();
    if (jobIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(matchResults)
      .where(inArray(matchResults.jobId, [...jobIds]))
      .orderBy(desc(matchResults.createdAt), desc(matchResults.id))
      .all();
    for (const row of rows)
      if (!out.has(row.jobId)) out.set(row.jobId, MatchResult.parse(row.data));
    return out;
  }
}

export class SqliteJobRequirementRepository implements JobRequirementRepository {
  constructor(private readonly db: Db) {}

  replaceForJob(
    jobId: string,
    requirements: readonly {
      key: string;
      text: string;
      kind: RequirementKind;
      evidence: string | null;
    }[],
  ): void {
    this.db.transaction(
      (tx) => {
        tx.delete(jobRequirements).where(eq(jobRequirements.jobId, jobId)).run();
        for (const r of requirements) {
          tx.insert(jobRequirements)
            .values({
              id: uuidv7(),
              jobId,
              requirementKey: r.key,
              text: r.text,
              kind: r.kind,
              evidence: r.evidence,
            })
            .run();
        }
      },
      { behavior: "immediate" },
    );
  }

  listForJob(jobId: string): JobRequirement[] {
    return this.db
      .select()
      .from(jobRequirements)
      .where(eq(jobRequirements.jobId, jobId))
      .all()
      .map((r) =>
        JobRequirement.parse({
          jobId: r.jobId,
          key: r.requirementKey,
          text: r.text,
          kind: r.kind,
          evidence: r.evidence,
        }),
      )
      .sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
  }
}

export class SqliteProviderRunRepository implements ProviderRunRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  record(run: ProviderRunRecord): void {
    this.db
      .insert(providerRuns)
      .values({ ...run, id: uuidv7(), createdAt: this.now() })
      .run();
  }

  costSince(sinceIso: string): number {
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)` })
      .from(providerRuns)
      .where(and(gte(providerRuns.createdAt, fromIso(sinceIso))))
      .get();
    return row?.total ?? 0;
  }

  usageSince(sinceIso: string): ProviderUsageRow[] {
    const ok = sql`${providerRuns.errorClass} IS NULL`;
    return this.db
      .select({
        provider: providerRuns.provider,
        taskType: providerRuns.taskType,
        calls: sql<number>`count(*)`,
        errors: sql<number>`sum(CASE WHEN ${providerRuns.errorClass} IS NOT NULL THEN 1 ELSE 0 END)`,
        fallbacks: sql<number>`sum(CASE WHEN ${providerRuns.fallback} THEN 1 ELSE 0 END)`,
        delegated: sql<number>`sum(CASE WHEN ${providerRuns.delegated} THEN 1 ELSE 0 END)`,
        inputTokens: sql<number>`coalesce(sum(${providerRuns.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${providerRuns.outputTokens}), 0)`,
        costUsd: sql<number>`coalesce(sum(${providerRuns.costUsd}), 0)`,
        unpricedCalls: sql<number>`sum(CASE WHEN ${ok} AND ${providerRuns.costUsd} IS NULL THEN 1 ELSE 0 END)`,
      })
      .from(providerRuns)
      .where(gte(providerRuns.createdAt, fromIso(sinceIso)))
      .groupBy(providerRuns.provider, providerRuns.taskType)
      .orderBy(providerRuns.provider, providerRuns.taskType)
      .all();
  }
}
