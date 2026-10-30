import { CareerAgentError, type DiscoveryPorts } from "@career-agent/domain";
import { createSourceHttp, SourceHttpError, type HttpGet } from "./http.js";
import { importJobUrl } from "./import-url.js";
import { adapterFor } from "./registry.js";

function describeHttp(e: SourceHttpError): {
  errorClass: string;
  message: string;
  retryable: boolean;
} {
  switch (e.kind) {
    case "http":
      if (e.status === 404)
        return {
          errorClass: "source_not_found",
          message: "The job board was not found. Check the board name.",
          retryable: false,
        };
      if (e.status === 429)
        return {
          errorClass: "source_rate_limited",
          message: "The job board is rate-limiting requests. It will be retried later.",
          retryable: true,
        };
      if (e.status !== null && e.status >= 500)
        return {
          errorClass: "source_unavailable",
          message: `The job board returned an error (HTTP ${e.status}).`,
          retryable: true,
        };
      return {
        errorClass: "source_http",
        message: `The job board refused the request (HTTP ${e.status ?? "?"}).`,
        retryable: false,
      };
    case "network":
    case "timeout":
      return {
        errorClass: `source_${e.kind}`,
        message: "Could not reach the job board.",
        retryable: true,
      };
    case "schema":
      return { errorClass: "source_schema", message: e.message, retryable: false };
    case "policy":
      return {
        errorClass: "source_policy",
        message: "The request was blocked by the URL policy.",
        retryable: false,
      };
    default:
      return { errorClass: `source_${e.kind}`, message: e.message, retryable: false };
  }
}

/** Discovery ports backed by the approved adapters and the SSRF-safe, paced HTTP client. */
export function createDiscoveryPorts(
  opts: { http?: HttpGet; now?: () => Date } = {},
): DiscoveryPorts {
  const http = opts.http ?? createSourceHttp();
  const now = opts.now ?? (() => new Date());
  return {
    allowedHosts: (type) => adapterFor(type)?.allowedHosts ?? null,
    validateIdentifier: (type, identifier) => {
      const a = adapterFor(type);
      if (!a) throw new Error(`No adapter for ${type}`);
      return a.validateIdentifier(identifier);
    },
    fetchSource: (source, previous, signal) => {
      const a = adapterFor(source.type);
      if (!a) return Promise.reject(new Error(`No adapter for ${source.type}`));
      return a.fetchAll(source, { http, now: now(), previous, ...(signal ? { signal } : {}) });
    },
    importUrl: async (url, allowGenericReader, signal) => {
      const r = await importJobUrl(
        url,
        { http, now: now(), ...(signal ? { signal } : {}) },
        { allowGenericReader },
      );
      return { job: r.job, via: r.via };
    },
    describeError: (err) => {
      if (err instanceof SourceHttpError) return describeHttp(err);
      if (err instanceof CareerAgentError)
        return { errorClass: err.code.toLowerCase(), message: err.message, retryable: false };
      return {
        errorClass: "internal",
        message: "Unexpected error while reading the job board.",
        retryable: false,
      };
    },
  };
}
