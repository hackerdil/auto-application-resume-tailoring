import { z } from "zod";
import { NotFoundError } from "@career-agent/domain";
import { htmlToText, sanitizeJobHtml } from "../html.js";
import { compensationFrom, employmentTypeFrom, toJob, workModeFrom } from "../normalize.js";
import { getJson, parseEnvelope, prettyName, validateIdentifier } from "./shared.js";
import type { JobSourceAdapter, SourceRef } from "./types.js";

const API = "https://api.ashbyhq.com/posting-api/job-board";

const AshbyJob = z.object({
  // Not documented; when absent the id is taken from jobUrl's last path segment.
  id: z.string().nullish(),
  title: z.string().min(1),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
  employmentType: z.string().nullish(),
  jobUrl: z.httpUrl(),
  applyUrl: z.httpUrl().nullish(),
  compensation: z
    .object({
      summaryComponents: z
        .array(
          z.object({
            compensationType: z.string().nullish(),
            interval: z.string().nullish(),
            currencyCode: z.string().nullish(),
            minValue: z.number().nullish(),
            maxValue: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
type AshbyJob = z.infer<typeof AshbyJob>;

const AshbyBoard = z.object({ jobs: z.array(z.unknown()) });

function jobId(j: AshbyJob): string | null {
  if (j.id) return j.id;
  const seg = new URL(j.jobUrl).pathname.split("/").filter(Boolean).pop();
  return seg && /^[0-9a-f-]{36}$/i.test(seg) ? seg.toLowerCase() : null;
}

function draft(board: string, company: string, id: string, j: AshbyJob, raw: unknown) {
  const html = j.descriptionHtml ?? "";
  const salary = j.compensation?.summaryComponents?.find((c) =>
    /salary/i.test(c.compensationType ?? ""),
  );
  return {
    source: "ashby" as const,
    externalId: `${board}/${id}`,
    sourceUrl: j.jobUrl,
    applyUrl: j.applyUrl ?? null,
    company,
    title: j.title,
    team: j.team ?? j.department ?? null,
    locations: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(
      (x): x is string => !!x,
    ),
    workMode: workModeFrom(j.workplaceType, j.isRemote === true ? true : null),
    employmentType: employmentTypeFrom(j.employmentType),
    descriptionText: html ? htmlToText(html) : (j.descriptionPlain ?? ""),
    descriptionHtmlSanitized: html ? sanitizeJobHtml(html) : null,
    compensation: salary
      ? compensationFrom(salary.minValue, salary.maxValue, salary.currencyCode, salary.interval)
      : null,
    postedAt: j.publishedAt ?? null,
    updatedAt: null,
    raw,
  };
}

export const ashbyAdapter: JobSourceAdapter = {
  type: "ashby",
  allowedHosts: ["api.ashbyhq.com"],
  validateIdentifier: (id) => validateIdentifier(id),

  async fetchAll(source: SourceRef, ctx) {
    const board = validateIdentifier(source.identifier);
    const url = `${API}/${encodeURIComponent(board)}?includeCompensation=true`;
    const res = await getJson(ctx.http, url, this.allowedHosts, ctx, true);
    if (res.notModified)
      return {
        url,
        httpStatus: 304,
        notModified: true,
        jobs: [],
        skipped: 0,
        rawHash: null,
        etag: res.etag,
        lastModified: res.lastModified,
      };
    const env = parseEnvelope(AshbyBoard, res.body, "Ashby");
    const company = source.displayName ?? prettyName(board);
    const jobs = [];
    let skipped = 0;
    for (const raw of env.jobs) {
      const j = AshbyJob.safeParse(raw);
      const id = j.success ? jobId(j.data) : null;
      if (!j.success || !id) {
        skipped++;
        continue;
      }
      if (j.data.isListed === false) continue;
      jobs.push(toJob(draft(board, company, id, j.data, raw), ctx.now));
    }
    return {
      url,
      httpStatus: res.status,
      notModified: false,
      jobs,
      skipped,
      rawHash: res.rawHash,
      etag: res.etag,
      lastModified: res.lastModified,
    };
  },

  matchJobUrl(url) {
    if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;
    const m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(url.pathname);
    return m?.[1] && m[2]
      ? { identifier: decodeURIComponent(m[1]).toLowerCase(), externalId: m[2].toLowerCase() }
      : null;
  },

  /** Ashby has no documented single-job endpoint; fetch the board and pick the posting. */
  async fetchOne(source, externalId, ctx) {
    const id = (externalId.split("/").pop() ?? "").toLowerCase();
    const all = await this.fetchAll(source, { ...ctx, previous: null });
    const job = all.jobs.find((j) => j.externalId.toLowerCase().endsWith(`/${id}`));
    if (!job) throw new NotFoundError("That Ashby posting is not listed on the board.");
    return job;
  },
};
