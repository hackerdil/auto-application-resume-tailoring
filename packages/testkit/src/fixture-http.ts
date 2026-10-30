import { readFileSync } from "node:fs";

export interface FixtureRoute {
  /** File under fixtures/ (e.g. "ats/lever-postings.json"), or an inline body. */
  file?: string;
  body?: string;
  status?: number;
  headers?: Record<string, string>;
}

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

/**
 * HTTP stand-in for source adapters: serves fixtures by exact URL, records requests, 404s everything else.
 * Routes can be changed between calls to simulate a board changing over time. Never touches the network.
 */
export function createFixtureHttp(routes: Record<string, FixtureRoute | FixtureRoute[]>) {
  const calls: string[] = [];
  const http = (url: string): Promise<FixtureResponse> => {
    calls.push(url);
    const entry = routes[url];
    const r = Array.isArray(entry) ? entry.shift() : entry;
    if (!r)
      return Promise.resolve({ status: 404, headers: {}, body: Buffer.alloc(0), finalUrl: url });
    const body = r.file
      ? readFileSync(new URL(`../../../fixtures/${r.file}`, import.meta.url))
      : Buffer.from(r.body ?? "");
    return Promise.resolve({
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...r.headers },
      body,
      finalUrl: url,
    });
  };
  return { http, calls, routes };
}
