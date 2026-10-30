import { Parser } from "htmlparser2";
import { z } from "zod";
import { ValidationError, type Job } from "@career-agent/domain";
import { sha256Hex } from "@career-agent/security";
import { htmlToText, sanitizeJobHtml } from "../html.js";
import { compensationFrom, employmentTypeFrom, toJob, workModeFrom } from "../normalize.js";

/** Collects the contents of <script type="application/ld+json"> blocks. Nothing on the page is executed. */
export function extractJsonLd(html: string): unknown[] {
  const blocks: string[] = [];
  let inLd = false;
  let buf = "";
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (
          name === "script" &&
          (attrs["type"] ?? "").toLowerCase().trim() === "application/ld+json"
        ) {
          inLd = true;
          buf = "";
        }
      },
      ontext(t) {
        if (inLd) buf += t;
      },
      onclosetag(name) {
        if (name === "script" && inLd) {
          inLd = false;
          blocks.push(buf);
        }
      },
    },
    { decodeEntities: false },
  );
  parser.write(html);
  parser.end();
  const out: unknown[] = [];
  for (const b of blocks.slice(0, 20)) {
    try {
      out.push(JSON.parse(b) as unknown);
    } catch {
      // Malformed structured data is ignored.
    }
  }
  return out;
}

function findJobPosting(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findJobPosting(n, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  const type = o["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return o;
  return findJobPosting(o["@graph"], depth + 1);
}

const str = z.string().trim().min(1);
const Place = z.object({
  address: z
    .union([
      z.string(),
      z.object({
        addressLocality: z.string().nullish(),
        addressRegion: z.string().nullish(),
        addressCountry: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
      }),
    ])
    .nullish(),
});
const Posting = z.object({
  title: str,
  description: z.string().nullish(),
  datePosted: z.string().nullish(),
  employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
  hiringOrganization: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
  jobLocation: z.union([Place, z.array(Place)]).nullish(),
  jobLocationType: z.string().nullish(),
  identifier: z
    .union([z.string(), z.object({ value: z.union([z.string(), z.number()]).nullish() })])
    .nullish(),
  url: z.string().nullish(),
  baseSalary: z
    .object({
      currency: z.string().nullish(),
      value: z
        .union([
          z.number(),
          z.object({
            minValue: z.number().nullish(),
            maxValue: z.number().nullish(),
            value: z.number().nullish(),
            unitText: z.string().nullish(),
          }),
        ])
        .nullish(),
    })
    .nullish(),
});

function placeName(p: z.infer<typeof Place>): string | null {
  const a = p.address;
  if (!a) return null;
  if (typeof a === "string") return a;
  const country =
    typeof a.addressCountry === "string" ? a.addressCountry : (a.addressCountry?.name ?? null);
  return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(", ") || null;
}

/**
 * Generic career-page reader (opt-in, read-only): uses schema.org JobPosting structured data only.
 * Pages without it are rejected rather than scraped heuristically.
 */
export function jobFromHtml(html: string, pageUrl: URL, now: Date): Job {
  const posting = extractJsonLd(html)
    .map((n) => findJobPosting(n))
    .find((x) => x !== null);
  if (!posting)
    throw new ValidationError(
      "This page has no structured job posting data (schema.org JobPosting). Supported job boards are Greenhouse, Lever, and Ashby.",
    );
  const p = Posting.safeParse(posting);
  if (!p.success)
    throw new ValidationError(
      "The page's job posting data is incomplete (it needs at least a title).",
    );
  const d = p.data;
  const html2 = d.description ?? "";
  const places =
    d.jobLocation === null || d.jobLocation === undefined
      ? []
      : Array.isArray(d.jobLocation)
        ? d.jobLocation
        : [d.jobLocation];
  const idValue = typeof d.identifier === "string" ? d.identifier : (d.identifier?.value ?? null);
  const externalId = `${pageUrl.hostname}/${idValue != null ? String(idValue) : sha256Hex(pageUrl.origin + pageUrl.pathname).slice(0, 16)}`;
  const sal = d.baseSalary;
  const v = sal?.value;
  const compensation =
    sal && v != null
      ? typeof v === "number"
        ? compensationFrom(v, v, sal.currency, null)
        : compensationFrom(v.minValue ?? v.value, v.maxValue ?? v.value, sal.currency, v.unitText)
      : null;
  const org =
    typeof d.hiringOrganization === "string"
      ? d.hiringOrganization
      : (d.hiringOrganization?.name ?? null);
  return toJob(
    {
      source: "generic",
      externalId,
      sourceUrl: pageUrl.toString(),
      applyUrl: pageUrl.toString(),
      company: org ?? pageUrl.hostname,
      title: d.title,
      team: null,
      locations: places.map(placeName).filter((x): x is string => !!x),
      workMode: workModeFrom(d.jobLocationType),
      employmentType: employmentTypeFrom(
        Array.isArray(d.employmentType) ? d.employmentType[0] : d.employmentType,
      ),
      descriptionText: htmlToText(html2),
      descriptionHtmlSanitized: html2 ? sanitizeJobHtml(html2) : null,
      compensation,
      postedAt: d.datePosted ?? null,
      updatedAt: null,
      raw: posting,
    },
    now,
  );
}
