import {
  safeFetch,
  SafeFetchError,
  type SafeResponse,
  type UrlPolicy,
} from "@career-agent/security";

export interface HttpGetOptions {
  policy: UrlPolicy;
  headers?: Record<string, string>;
  accept?: readonly string[];
  maxBytes?: number;
  signal?: AbortSignal;
}

export type HttpGet = (url: string, opts: HttpGetOptions) => Promise<SafeResponse>;

export class SourceHttpError extends Error {
  constructor(
    readonly status: number | null,
    readonly kind:
      "http" | "network" | "timeout" | "policy" | "too_large" | "content_type" | "schema",
    message: string,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new SourceHttpError(null, "timeout", "Cancelled."));
    });
  });

/** Per-origin pacing: at most one request per `minIntervalMs` to any origin (polite crawling). */
export class OriginScheduler {
  private readonly next = new Map<string, number>();
  constructor(
    private readonly minIntervalMs = 1000,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ) {}

  async acquire(url: string, signal?: AbortSignal): Promise<void> {
    const origin = new URL(url).origin;
    const t = this.now();
    const at = Math.max(t, this.next.get(origin) ?? 0);
    this.next.set(origin, at + this.minIntervalMs);
    if (at > t) await this.wait(at - t, signal);
  }

  /** Pushes the origin's next slot back, e.g. after a 429 with Retry-After. */
  backoff(url: string, ms: number): void {
    const origin = new URL(url).origin;
    this.next.set(origin, Math.max(this.next.get(origin) ?? 0, this.now() + ms));
  }
}

export interface RetryingClientOptions {
  scheduler?: OriginScheduler;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  get?: HttpGet;
  random?: () => number;
}

/**
 * GET with per-origin pacing and bounded retries. Retries only network errors, timeouts, 429 and 5xx with
 * capped exponential backoff + jitter, honoring Retry-After (capped). Other 4xx fail immediately.
 * Returns 304 responses as-is so callers can use conditional requests.
 */
export function createSourceHttp(opts: RetryingClientOptions = {}): HttpGet {
  const scheduler = opts.scheduler ?? new OriginScheduler();
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 10_000;
  const get: HttpGet = opts.get ?? ((url, o) => safeFetch(url, { ...o, timeoutMs: 15_000 }));
  const random = opts.random ?? Math.random;

  return async (url, o) => {
    for (let attempt = 0; ; attempt++) {
      await scheduler.acquire(url, o.signal);
      let res: SafeResponse | null = null;
      let retryable = false;
      let error: SourceHttpError;
      try {
        res = await get(url, o);
        if (res.status === 304 || (res.status >= 200 && res.status < 300)) return res;
        retryable = res.status === 429 || res.status >= 500;
        error = new SourceHttpError(res.status, "http", `HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof SafeFetchError) {
          retryable = err.kind === "network" || err.kind === "timeout";
          const kind = err.kind === "redirect" || err.kind === "aborted" ? "network" : err.kind;
          error = new SourceHttpError(null, kind, err.message);
        } else if (err instanceof Error && err.name === "PolicyError") {
          error = new SourceHttpError(null, "policy", err.message);
        } else throw err;
      }
      if (!retryable || attempt >= maxRetries || o.signal?.aborted) throw error;
      const retryAfter = Number(res?.headers["retry-after"]);
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : Math.min(cap, base * 2 ** attempt) * (0.5 + random() / 2);
      scheduler.backoff(url, delay);
    }
  };
}
