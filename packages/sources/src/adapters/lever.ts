import { z } from "zod";
import { ValidationError } from "@career-agent/domain";
import { htmlToText, sanitizeJobHtml } from "../html.js";
import { compensationFrom, employmentTypeFrom, toJob, workModeFrom } from "../normalize.js";
import { getJson, parseEnvelope, prettyName, validateIdentifier } from "./shared.js";
import type { JobSourceAdapter, SourceRef } from "./types.js";

/** Identifiers are `<site>` for the global instance or `eu/<site>` for the EU instance. */
const LEVER_ID = /^(eu\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const apiBase = (identifier: string) =>
  identifier.startsWith("eu/")
    ? { base: "https://api.eu.lever.co/v0/postings", site: identifier.slice(3) }
    : { base: "https://api.lever.co/v0/postings", site: identifier };

const LeverPosting = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.httpUrl(),
  applyUrl: z.httpUrl().nullish(),
  createdAt: z.number().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      commitment: z.string().nullish(),
      team: z.string().nullish(),
      department: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  additional: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  workplaceType: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});
type LeverPosting = z.infer<typeof LeverPosting>;

const PREFERRED = /\b(preferred|nice[- ]to[- ]have|bonus|plus)/i;
const REQUIRED =
  /\b(requirement|qualification|you have|you['’]ll need|what we['’]re looking for|must|skills|about you)/i;

function draft(identifier: string, company: string, p: LeverPosting, raw: unknown) {
  const lists = p.lists ?? [];
  const html = [
    p.description ?? "",
    ...lists.map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`),
    p.additional ?? "",
  ].join("\n");
  const required: string[] = [];
  const preferred: string[] = [];
  for (const l of lists) {
    const items = htmlToText(`<ul>${l.content}</ul>`)
      .split("\n")
      .map((x) => x.replace(/^•\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 30);
    if (PREFERRED.test(l.text)) preferred.push(...items);
    else if (REQUIRED.test(l.text)) required.push(...items);
  }
  const c = p.categories ?? {};
  return {
    source: "lever" as const,
    externalId: `${identifier}/${p.id}`,
    sourceUrl: p.hostedUrl,
    applyUrl: p.applyUrl ?? null,
    company,
    title: p.text,
    team: c.team ?? c.department ?? null,
    locations: c.allLocations?.length ? c.allLocations : c.location ? [c.location] : [],
    workMode: workModeFrom(p.workplaceType),
    employmentType: employmentTypeFrom(c.commitment),
    descriptionText: htmlToText(html),
    descriptionHtmlSanitized: sanitizeJobHtml(html),
    qualifications: { required, preferred },
    compensation: p.salaryRange
      ? compensationFrom(
          p.salaryRange.min,
          p.salaryRange.max,
          p.salaryRange.currency,
          p.salaryRange.interval,
        )
      : null,
    postedAt: p.createdAt == null ? null : new Date(p.createdAt).toISOString(),
    updatedAt: null,
    raw,
  };
}

export const leverAdapter: JobSourceAdapter = {
  type: "lever",
  allowedHosts: ["api.lever.co", "api.eu.lever.co"],
  validateIdentifier: (id) => validateIdentifier(id, LEVER_ID),

  async fetchAll(source: SourceRef, ctx) {
    const identifier = validateIdentifier(source.identifier, LEVER_ID);
    const { base, site } = apiBase(identifier);
    const url = `${base}/${encodeURIComponent(site)}?mode=json`;
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
    const items = parseEnvelope(z.array(z.unknown()), res.body, "Lever");
    const company = source.displayName ?? prettyName(identifier);
    const jobs = [];
    let skipped = 0;
    for (const raw of items) {
      const p = LeverPosting.safeParse(raw);
      if (!p.success) {
        skipped++;
        continue;
      }
      jobs.push(toJob(draft(identifier, company, p.data, raw), ctx.now));
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
    const host = url.hostname.toLowerCase();
    if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;
    const m = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(url.pathname);
    if (!m?.[1] || !m[2]) return null;
    const site = m[1].toLowerCase();
    return {
      identifier: host === "jobs.eu.lever.co" ? `eu/${site}` : site,
      externalId: m[2].toLowerCase(),
    };
  },

  async fetchOne(source, externalId, ctx) {
    const identifier = validateIdentifier(source.identifier, LEVER_ID);
    const id = externalId.split("/").pop() ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError("Lever posting id is invalid.");
    const { base, site } = apiBase(identifier);
    const res = await getJson(
      ctx.http,
      `${base}/${encodeURIComponent(site)}/${id}`,
      this.allowedHosts,
      ctx,
      false,
    );
    const p = parseEnvelope(LeverPosting, res.body, "Lever posting");
    return toJob(
      draft(identifier, source.displayName ?? prettyName(identifier), p, res.body),
      ctx.now,
    );
  },
};
