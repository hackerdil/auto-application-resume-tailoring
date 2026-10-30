import { PolicyError, ValidationError, type Job } from "@career-agent/domain";
import { checkUrl } from "@career-agent/security";
import { ADAPTERS } from "./registry.js";
import { jobFromHtml } from "./adapters/generic.js";
import type { FetchContext } from "./adapters/types.js";

export interface ImportedJob {
  job: Job;
  via: "greenhouse" | "lever" | "ashby" | "generic";
  sourceIdentifier: string | null;
}

/**
 * Manual job URL import. Known ATS URLs go through that ATS's public API. Any other URL is only read when the
 * owner opted in to the generic reader, and then only for schema.org JobPosting data (spec §10).
 */
export async function importJobUrl(
  raw: string,
  ctx: FetchContext,
  opts: { allowGenericReader: boolean },
): Promise<ImportedJob> {
  let url: URL;
  try {
    url = checkUrl(raw.trim());
  } catch (err) {
    if (err instanceof PolicyError)
      throw new ValidationError(`That URL cannot be imported: ${err.message}`);
    throw err;
  }
  for (const adapter of Object.values(ADAPTERS)) {
    const m = adapter.matchJobUrl(url);
    if (m) {
      const job = await adapter.fetchOne(
        { type: adapter.type, identifier: m.identifier },
        m.externalId,
        ctx,
      );
      return { job, via: adapter.type as ImportedJob["via"], sourceIdentifier: m.identifier };
    }
  }
  if (/(^|\.)(linkedin\.com|indeed\.[a-z.]+)$/i.test(url.hostname)) {
    throw new ValidationError(
      "LinkedIn and Indeed pages are not supported: their terms prohibit automated access. Open the employer's own posting instead.",
    );
  }
  if (!opts.allowGenericReader) {
    throw new ValidationError(
      "This is not a Greenhouse, Lever, or Ashby posting. Enable the generic career-page reader to import it.",
    );
  }
  const res = await ctx.http(url.toString(), {
    policy: {},
    accept: ["text/html", "application/xhtml+xml"],
    maxBytes: 3 * 1024 * 1024,
    headers: { accept: "text/html" },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status !== 200) throw new ValidationError(`The page returned HTTP ${res.status}.`);
  return {
    job: jobFromHtml(res.body.toString("utf8"), new URL(res.finalUrl), ctx.now),
    via: "generic",
    sourceIdentifier: null,
  };
}
