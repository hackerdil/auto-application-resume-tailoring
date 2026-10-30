import { applyHardFilters } from "../filters.js";
import { PolicyError, ValidationError } from "../errors.js";
import type {
  AuditRepository,
  JobFetchRecord,
  JobFetchRepository,
  JobRepository,
  JobSourceRecord,
  JobSourceRepository,
  NewAuditEvent,
  ProfileRepository,
} from "../repositories.js";
import type { Job, JobSourceType, JobStatus } from "../schemas/job.js";

/** Ports implemented by @career-agent/sources; structural so the domain stays free of HTTP code. */
export interface DiscoveryPorts {
  allowedHosts(type: JobSourceType): readonly string[] | null;
  validateIdentifier(type: JobSourceType, identifier: string): string;
  fetchSource(
    source: JobSourceRecord,
    previous: { etag: string | null; lastModified: string | null } | null,
    signal?: AbortSignal,
  ): Promise<{
    url: string;
    httpStatus: number;
    notModified: boolean;
    jobs: Job[];
    skipped: number;
    rawHash: string | null;
    etag: string | null;
    lastModified: string | null;
  }>;
  importUrl(
    url: string,
    allowGenericReader: boolean,
    signal?: AbortSignal,
  ): Promise<{ job: Job; via: string }>;
  /** Maps an adapter error to a safe class and message for storage and display. */
  describeError(err: unknown): { errorClass: string; message: string; retryable: boolean };
}

export interface DiscoveryDeps {
  jobs: JobRepository;
  sources: JobSourceRepository;
  fetches: JobFetchRepository;
  profiles: ProfileRepository;
  audit: AuditRepository;
  ports: DiscoveryPorts;
  freshnessDays: number;
  enableWorkable?: boolean;
  now?: () => Date;
}

export interface SourceRunSummary {
  sourceId: string;
  outcome: "ok" | "not_modified" | "error" | "disabled";
  listed: number;
  created: number;
  updated: number;
  eligible: number;
  filtered: number;
  removed: number;
  skipped: number;
  error?: { errorClass: string; message: string; retryable: boolean };
}

/** Worker task kind for one discovery run of one source. */
export const DISCOVER_SOURCE_TASK = "discover_source";
/** Idempotency-key prefix shared by all discovery tasks of a source; used to prevent overlapping runs. */
export const discoveryKeyPrefix = (sourceId: string): string => `discover:${sourceId}:`;

const USER_STATUSES: readonly JobStatus[] = ["SHORTLISTED", "SKIPPED", "ARCHIVED"];

const audit = (
  traceId: string,
  actor: NewAuditEvent["actor"],
  type: string,
  metadata: Record<string, unknown>,
  jobId: string | null = null,
): NewAuditEvent => ({
  traceId,
  runId: null,
  taskId: null,
  applicationId: null,
  jobId,
  actor,
  type,
  prevState: null,
  newState: null,
  approvalId: null,
  artifactHashes: [],
  provider: null,
  model: null,
  durationMs: null,
  metadata,
});

/** Job discovery (spec §9 Job Source Worker, §10): fetch → normalize → dedupe → hard filters. No LLM. */
export class DiscoveryService {
  private readonly now: () => Date;

  constructor(private readonly d: DiscoveryDeps) {
    this.now = d.now ?? (() => new Date());
  }

  addSource(
    input: { type: JobSourceType; identifier: string; displayName?: string | null },
    traceId: string,
  ): JobSourceRecord {
    if (input.type === "workable" && !this.d.enableWorkable)
      throw new PolicyError(
        "Workable is disabled until its terms and limits are reviewed (ENABLE_WORKABLE).",
      );
    const hosts = this.d.ports.allowedHosts(input.type);
    if (!hosts)
      throw new ValidationError(
        `"${input.type}" is not a supported discovery source. Use Greenhouse, Lever, or Ashby, or import a job URL.`,
      );
    const identifier = this.d.ports.validateIdentifier(input.type, input.identifier);
    const displayName = input.displayName?.trim() || null;
    const source = this.d.sources.add({
      type: input.type,
      identifier,
      displayName,
      allowedHosts: [...hosts],
    });
    this.d.audit.append(
      audit(traceId, "user", "job_source.added", {
        sourceId: source.id,
        type: source.type,
        identifier,
      }),
    );
    return source;
  }

  /** Runs one source. Failures are recorded and returned, never thrown, so other sources keep running. */
  async runSource(
    sourceId: string,
    ownerId: string,
    traceId: string,
    signal?: AbortSignal,
  ): Promise<SourceRunSummary> {
    const empty = {
      listed: 0,
      created: 0,
      updated: 0,
      eligible: 0,
      filtered: 0,
      removed: 0,
      skipped: 0,
    };
    const source = this.d.sources.get(sourceId);
    if (!source) throw new ValidationError("Unknown job source.");
    if (!source.enabled) return { sourceId, outcome: "disabled", ...empty };

    const previous = this.d.fetches.latestSuccessForSource(sourceId);
    const started = Date.now();
    const base: Omit<JobFetchRecord, "id" | "outcome" | "url" | "httpStatus"> = {
      jobSourceId: sourceId,
      fetchedAt: this.now().toISOString(),
      etag: null,
      lastModified: null,
      rawHash: null,
      errorClass: null,
      errorMessage: null,
      itemCount: 0,
      skippedCount: 0,
      newCount: 0,
      durationMs: null,
    };

    let result: Awaited<ReturnType<DiscoveryPorts["fetchSource"]>>;
    try {
      result = await this.d.ports.fetchSource(
        source,
        previous ? { etag: previous.etag, lastModified: previous.lastModified } : null,
        signal,
      );
    } catch (err) {
      const e = this.d.ports.describeError(err);
      this.d.fetches.record({
        ...base,
        url: `${source.type}:${source.identifier}`,
        httpStatus: null,
        outcome: "error",
        errorClass: e.errorClass,
        errorMessage: e.message,
        durationMs: Date.now() - started,
      });
      this.d.audit.append(
        audit(traceId, "system", "discovery.source_failed", { sourceId, errorClass: e.errorClass }),
      );
      return { sourceId, outcome: "error", ...empty, error: e };
    }

    if (result.notModified) {
      this.d.fetches.record({
        ...base,
        url: result.url,
        httpStatus: result.httpStatus,
        outcome: "not_modified",
        etag: result.etag,
        lastModified: result.lastModified,
        durationMs: Date.now() - started,
      });
      return { sourceId, outcome: "not_modified", ...empty };
    }

    const prefs = this.d.profiles.get(ownerId)?.preferences ?? null;
    const summary: SourceRunSummary = {
      sourceId,
      outcome: "ok",
      ...empty,
      listed: result.jobs.length,
      skipped: result.skipped,
    };
    for (const job of result.jobs) {
      const r = this.ingest(job, sourceId, prefs, traceId);
      if (r.created) summary.created++;
      if (r.updated) summary.updated++;
      if (r.status === "ELIGIBLE" && r.created) summary.eligible++;
      if (r.status === "FILTERED" && r.created) summary.filtered++;
    }
    summary.removed = this.d.jobs.markRemoved(
      sourceId,
      result.jobs.map((j) => j.id),
      this.now().toISOString(),
    );
    this.d.fetches.record({
      ...base,
      url: result.url,
      httpStatus: result.httpStatus,
      outcome: "ok",
      etag: result.etag,
      lastModified: result.lastModified,
      rawHash: result.rawHash,
      itemCount: result.jobs.length,
      skippedCount: result.skipped,
      newCount: summary.created,
      durationMs: Date.now() - started,
    });
    this.d.audit.append(audit(traceId, "system", "discovery.source_completed", { ...summary }));
    return summary;
  }

  async importUrl(
    ownerId: string,
    url: string,
    allowGenericReader: boolean,
    traceId: string,
    signal?: AbortSignal,
  ): Promise<{ job: Job; created: boolean; via: string }> {
    const { job, via } = await this.d.ports.importUrl(url, allowGenericReader, signal);
    const prefs = this.d.profiles.get(ownerId)?.preferences ?? null;
    const r = this.ingest(job, null, prefs, traceId);
    this.d.audit.append(
      audit(traceId, "user", "job.imported", { via, created: r.created }, job.id),
    );
    const stored = this.d.jobs.get(job.id);
    if (!stored) throw new ValidationError("The job could not be stored.");
    return { job: stored, created: r.created, via };
  }

  /** Owner decisions on a job: shortlist, skip, or archive (validated by the job state machine). */
  setStatus(jobId: string, to: JobStatus, traceId: string): Job {
    if (!USER_STATUSES.includes(to))
      throw new ValidationError("You can only shortlist, skip, or archive a job.");
    return this.d.jobs.transition(jobId, to, { traceId, actor: "user" });
  }

  private ingest(
    job: Job,
    sourceId: string | null,
    prefs: Parameters<typeof applyHardFilters>[1],
    traceId: string,
  ): { created: boolean; updated: boolean; status: JobStatus } {
    const up = this.d.jobs.upsert(job, sourceId);
    if (up.outcome !== "created")
      return { created: false, updated: up.outcome === "updated", status: up.job.status };
    const duplicateOf = this.d.jobs.findByContentHash(job.contentHash, job.id)[0]?.id ?? null;
    const reasons = applyHardFilters(up.job, prefs, {
      now: this.now(),
      freshnessDays: this.d.freshnessDays,
      duplicateOf,
    });
    const to: JobStatus = reasons.length ? "FILTERED" : "ELIGIBLE";
    this.d.jobs.transition(job.id, to, { traceId, actor: "system" }, { filterReasons: reasons });
    return { created: true, updated: false, status: to };
  }
}
