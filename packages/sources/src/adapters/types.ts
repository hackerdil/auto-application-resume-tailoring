import type { Job, JobSourceType } from "@career-agent/domain";
import type { HttpGet } from "../http.js";

export interface SourceRef {
  type: JobSourceType;
  /** Board token / site name; validated by the adapter. */
  identifier: string;
  /** Optional display name for sources whose API does not return the company name. */
  displayName?: string | null;
}

export interface FetchContext {
  http: HttpGet;
  now: Date;
  signal?: AbortSignal;
  /** Validators from the previous successful fetch, for conditional requests. */
  previous?: { etag: string | null; lastModified: string | null } | null;
}

export interface SourceFetchResult {
  url: string;
  httpStatus: number;
  notModified: boolean;
  jobs: Job[];
  /** Items skipped because they did not match the expected schema (reported, not fatal). */
  skipped: number;
  rawHash: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface JobUrlMatch {
  identifier: string;
  externalId: string;
}

/** Spec §10: one adapter per approved source type. Adapters never use an LLM. */
export interface JobSourceAdapter {
  readonly type: JobSourceType;
  /** Hosts this adapter may contact. */
  readonly allowedHosts: readonly string[];
  /** Normalizes and validates an identifier; throws ValidationError when invalid. */
  validateIdentifier(identifier: string): string;
  fetchAll(source: SourceRef, ctx: FetchContext): Promise<SourceFetchResult>;
  /** Recognizes a public posting URL for this ATS. */
  matchJobUrl(url: URL): JobUrlMatch | null;
  fetchOne(source: SourceRef, externalId: string, ctx: FetchContext): Promise<Job>;
}
