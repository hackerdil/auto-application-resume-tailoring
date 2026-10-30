import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { PolicyError } from "@career-agent/domain";
import { checkUrl, isPublicIp, type UrlPolicy } from "./url-policy.js";

export interface SafeFetchOptions {
  policy: UrlPolicy;
  /** Maximum decompressed body size. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Accepted response media types (prefix match, e.g. "application/json"). Empty = any. */
  accept?: readonly string[];
  signal?: AbortSignal;
  /** DNS resolver; injectable for tests. Must return every address for the host. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

export class SafeFetchError extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "too_large" | "redirect" | "content_type" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

const DEFAULT_UA = "CareerAgent/0.1 (local personal job search; read-only)";

const systemResolve = (host: string) =>
  new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    dnsLookup(host, { all: true, order: "verbatim" }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs);
    });
  });

/**
 * SSRF-safe HTTP GET (docs/THREAT_MODEL.md T10):
 * - every URL and redirect hop passes `checkUrl` (scheme, credentials, port, host allowlist, private hosts);
 * - DNS is resolved by us inside the socket's `lookup`, every address must be public, and the socket connects to
 *   the vetted address (no time-of-check/time-of-use gap for DNS rebinding);
 * - decompressed size, total time, redirect count, and content type are bounded.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const signal = AbortSignal.any([
    AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    ...(opts.signal ? [opts.signal] : []),
  ]);
  let url = checkUrl(rawUrl, opts.policy);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, opts, signal);
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && res.headers["location"]) {
      if (hop >= maxRedirects) throw new SafeFetchError("redirect", "Too many redirects.");
      url = checkUrl(new URL(res.headers["location"], url), opts.policy);
      continue;
    }
    if (opts.accept?.length && res.status < 300) {
      const ct = (res.headers["content-type"] ?? "").toLowerCase();
      if (!opts.accept.some((a) => ct.startsWith(a)))
        throw new SafeFetchError("content_type", `Unexpected content type: ${ct || "none"}.`);
    }
    return { ...res, finalUrl: url.toString() };
  }
}

function makeLookup(
  policy: UrlPolicy,
  resolve: NonNullable<SafeFetchOptions["resolve"]>,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addrs) => {
        if (addrs.length === 0) throw new PolicyError("Host did not resolve.");
        if (!policy.allowPrivateNetwork && addrs.some((a) => !isPublicIp(a.address))) {
          throw new PolicyError("Host resolves to a non-public address.");
        }
        if (options.all) callback(null, addrs);
        else {
          const first = addrs[0];
          if (!first) throw new PolicyError("Host did not resolve.");
          callback(null, first.address, first.family);
        }
      })
      .catch((err: unknown) => {
        callback(err instanceof Error ? err : new Error("DNS failure"), "", 0);
      });
  };
}

function requestOnce(
  url: URL,
  opts: SafeFetchOptions,
  signal: AbortSignal,
): Promise<Omit<SafeResponse, "finalUrl">> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !opts.policy.allowPrivateNetwork && !isPublicIp(host)) {
    return Promise.reject(new PolicyError("Destination address is not public."));
  }
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        signal,
        lookup: makeLookup(opts.policy, opts.resolve ?? systemResolve),
        headers: {
          "user-agent": DEFAULT_UA,
          "accept-encoding": "gzip, br, deflate",
          ...opts.headers,
        },
        // Never reuse pooled sockets: each request must go through our vetted lookup.
        agent: false,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(headers["content-length"] ?? "0");
        if (declared > maxBytes && !headers["content-encoding"]) {
          res.destroy();
          reject(new SafeFetchError("too_large", "Response is too large."));
          return;
        }
        let stream: Readable = res;
        const enc = (headers["content-encoding"] ?? "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(createGunzip());
        else if (enc === "br") stream = res.pipe(createBrotliDecompress());
        else if (enc === "deflate") stream = res.pipe(createInflate());
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            stream.destroy();
            reject(new SafeFetchError("too_large", "Response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
        stream.on("error", (err) => {
          reject(new SafeFetchError("network", `Response stream failed: ${err.name}`));
        });
      },
    );
    req.on("error", (err) => {
      if (err instanceof PolicyError) reject(err);
      else if (signal.aborted) {
        const reason: unknown = signal.reason;
        reject(
          new SafeFetchError(
            reason instanceof DOMException && reason.name === "TimeoutError"
              ? "timeout"
              : "aborted",
            "Request timed out or was cancelled.",
          ),
        );
      } else
        reject(
          new SafeFetchError(
            "network",
            `Network error: ${(err as NodeJS.ErrnoException).code ?? err.name}`,
          ),
        );
    });
    req.end();
  });
}
