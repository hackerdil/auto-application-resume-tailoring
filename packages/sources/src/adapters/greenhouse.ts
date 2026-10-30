import { z } from "zod";
import { NotFoundError } from "@career-agent/domain";
import { decodeEntities, htmlToText, sanitizeJobHtml } from "../html.js";
import { compensationFrom, toJob, workModeFromLocation } from "../normalize.js";
import { getJson, parseEnvelope, validateIdentifier } from "./shared.js";
import type { JobSourceAdapter, SourceRef } from "./types.js";

const API = "https://boards-api.greenhouse.io/v1/boards";

const GhJob = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  absolute_url: z.httpUrl(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
  departments: z.array(z.object({ name: z.string() })).nullish(),
  company_name: z.string().nullish(),
  pay_input_ranges: z
    .array(
      z.object({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: z.string().nullish(),
        title: z.string().nullish(),
      }),
    )
    .nullish(),
});
type GhJob = z.infer<typeof GhJob>;

const GhList = z.object({ jobs: z.array(z.unknown()) });
const GhBoard = z.object({ name: z.string().min(1) });

function draft(token: string, company: string, j: GhJob, raw: unknown) {
  const html = j.content ? decodeEntities(j.content) : "";
  const pay = j.pay_input_ranges?.[0];
  const location = j.location?.name ?? null;
  return {
    source: "greenhouse" as const,
    externalId: `${token}/${j.id}`,
    sourceUrl: j.absolute_url,
    applyUrl: j.absolute_url,
    company: j.company_name ?? company,
    title: j.title,
    team: j.departments?.[0]?.name ?? null,
    locations: location ? location.split(/\s*;\s*/) : [],
    workMode: workModeFromLocation(location),
    employmentType: "unknown" as const,
    descriptionText: htmlToText(html),
    descriptionHtmlSanitized: html ? sanitizeJobHtml(html) : null,
    // Greenhouse pay ranges are only returned by the single-job endpoint; the period is not stated, so assume nothing.
    compensation: pay
      ? compensationFrom(
          pay.min_cents == null ? null : pay.min_cents / 100,
          pay.max_cents == null ? null : pay.max_cents / 100,
          pay.currency_type,
          pay.title,
        )
      : null,
    postedAt: j.first_published ?? null,
    updatedAt: j.updated_at ?? null,
    raw,
  };
}

export const greenhouseAdapter: JobSourceAdapter = {
  type: "greenhouse",
  allowedHosts: ["boards-api.greenhouse.io"],
  validateIdentifier: (id) => validateIdentifier(id),

  async fetchAll(source: SourceRef, ctx) {
    const token = validateIdentifier(source.identifier);
    const url = `${API}/${encodeURIComponent(token)}/jobs?content=true`;
    const list = await getJson(ctx.http, url, this.allowedHosts, ctx, true);
    if (list.notModified)
      return {
        url,
        httpStatus: 304,
        notModified: true,
        jobs: [],
        skipped: 0,
        rawHash: null,
        etag: list.etag,
        lastModified: list.lastModified,
      };
    const env = parseEnvelope(GhList, list.body, "Greenhouse");
    let company = source.displayName ?? null;
    if (!company) {
      const board = await getJson(
        ctx.http,
        `${API}/${encodeURIComponent(token)}`,
        this.allowedHosts,
        ctx,
        false,
      );
      company = GhBoard.safeParse(board.body).data?.name ?? token;
    }
    const jobs = [];
    let skipped = 0;
    for (const raw of env.jobs) {
      const j = GhJob.safeParse(raw);
      if (!j.success) {
        skipped++;
        continue;
      }
      jobs.push(toJob(draft(token, company, j.data, raw), ctx.now));
    }
    return {
      url,
      httpStatus: list.status,
      notModified: false,
      jobs,
      skipped,
      rawHash: list.rawHash,
      etag: list.etag,
      lastModified: list.lastModified,
    };
  },

  matchJobUrl(url) {
    const host = url.hostname.toLowerCase();
    if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
      const m = /^\/([^/]+)\/jobs\/(\d+)/.exec(url.pathname);
      if (m?.[1] && m[2]) return { identifier: m[1].toLowerCase(), externalId: m[2] };
      const forToken = url.searchParams.get("for");
      const jobId = url.searchParams.get("token") ?? url.searchParams.get("gh_jid");
      if (forToken && jobId && /^\d+$/.test(jobId))
        return { identifier: forToken.toLowerCase(), externalId: jobId };
    }
    return null;
  },

  async fetchOne(source, externalId, ctx) {
    const token = validateIdentifier(source.identifier);
    const id = externalId.includes("/") ? externalId.split("/").pop() : externalId;
    if (!id || !/^\d+$/.test(id)) throw new NotFoundError("Greenhouse job id is invalid.");
    const url = `${API}/${encodeURIComponent(token)}/jobs/${id}?pay_transparency=true`;
    const res = await getJson(ctx.http, url, this.allowedHosts, ctx, false);
    const j = parseEnvelope(GhJob, res.body, "Greenhouse job");
    return toJob(draft(token, source.displayName ?? j.company_name ?? token, j, res.body), ctx.now);
  },
};
