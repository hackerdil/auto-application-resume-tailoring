import { ValidationError } from "@career-agent/domain";
import { sha256Hex } from "@career-agent/security";
import type { z } from "zod";
import { SourceHttpError, type HttpGet } from "../http.js";
import type { FetchContext } from "./types.js";

export const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function validateIdentifier(identifier: string, re: RegExp = IDENTIFIER_RE): string {
  const id = identifier.trim().toLowerCase();
  if (!re.test(id))
    throw new ValidationError(
      "Invalid board identifier. Use the name from the job board URL (letters, digits, '-', '_', '.').",
    );
  return id;
}

export async function getJson(
  http: HttpGet,
  url: string,
  allowedHosts: readonly string[],
  ctx: Pick<FetchContext, "signal" | "previous">,
  conditional: boolean,
): Promise<{
  status: number;
  body: unknown;
  rawHash: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (conditional && ctx.previous?.etag) headers["if-none-match"] = ctx.previous.etag;
  if (conditional && ctx.previous?.lastModified)
    headers["if-modified-since"] = ctx.previous.lastModified;
  const res = await http(url, {
    policy: { allowedHosts },
    headers,
    accept: ["application/json"],
    maxBytes: 20 * 1024 * 1024,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const etag = res.headers["etag"] ?? null;
  const lastModified = res.headers["last-modified"] ?? null;
  if (res.status === 304)
    return {
      status: 304,
      body: null,
      rawHash: null,
      etag: ctx.previous?.etag ?? etag,
      lastModified: ctx.previous?.lastModified ?? lastModified,
      notModified: true,
    };
  if (res.status < 200 || res.status >= 300)
    throw new SourceHttpError(res.status, "http", `HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new SourceHttpError(res.status, "schema", "Response was not valid JSON.");
  }
  return {
    status: res.status,
    body,
    rawHash: sha256Hex(res.body),
    etag,
    lastModified,
    notModified: false,
  };
}

/** Parses the envelope strictly (a changed API fails visibly) and items individually (one bad item is skipped). */
export function parseEnvelope<T extends z.ZodType>(
  schema: T,
  body: unknown,
  what: string,
): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new SourceHttpError(
      null,
      "schema",
      `${what} response did not match the expected format (${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown"}).`,
    );
  }
  return r.data;
}

export function prettyName(identifier: string): string {
  return identifier
    .replace(/^eu\//, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
