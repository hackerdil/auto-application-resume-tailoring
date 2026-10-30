import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  deriveKey,
  hmacSha256Hex,
  randomTokenBase64Url,
  timingSafeEqualHex,
} from "@career-agent/security";
import { HttpError } from "./http-errors.js";

export const SESSION_COOKIE = "ca_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface LocalGuardOptions {
  sessionSecret: Buffer;
  /** Host header values accepted (DNS-rebinding defence), e.g. "127.0.0.1:3001", "localhost:3000". */
  allowedHosts: ReadonlySet<string>;
  /** Origins allowed to send mutating requests, e.g. "http://127.0.0.1:3000". */
  allowedOrigins: ReadonlySet<string>;
  now?: () => number;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, "");
  if (isIP(a) === 4) return a.startsWith("127.");
  return a === "::1";
}

/**
 * Local-only request guard (docs/THREAT_MODEL.md T8–T9):
 * loopback peers only, Host allowlist, signed session cookie, CSRF token + Origin/Fetch-Metadata checks on mutations.
 */
export class LocalGuard {
  private readonly sessionKey: Buffer;
  private readonly csrfKey: Buffer;
  private readonly now: () => number;

  constructor(private readonly opts: LocalGuardOptions) {
    this.sessionKey = deriveKey(opts.sessionSecret, "session-v1");
    this.csrfKey = deriveKey(opts.sessionSecret, "csrf-v1");
    this.now = opts.now ?? Date.now;
  }

  checkTransport(req: FastifyRequest): void {
    if (!isLoopback(req.socket.remoteAddress))
      throw new HttpError(403, "NOT_LOCAL", "Only local connections are accepted.");
    const host = (req.headers.host ?? "").toLowerCase();
    if (!this.opts.allowedHosts.has(host))
      throw new HttpError(421, "BAD_HOST", "Unexpected Host header.");
  }

  /** Issues (or refreshes) a session and returns its CSRF token. */
  issueSession(req: FastifyRequest, reply: FastifyReply): string {
    const existing = this.readSession(req);
    const sessionId = existing ?? `${randomTokenBase64Url(24)}.${this.now()}`;
    if (!existing) {
      reply.setCookie(SESSION_COOKIE, `${sessionId}.${hmacSha256Hex(this.sessionKey, sessionId)}`, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_MAX_AGE_MS / 1000,
        // Loopback HTTP: `secure` would prevent the browser from storing the cookie.
        secure: false,
      });
    }
    return hmacSha256Hex(this.csrfKey, sessionId);
  }

  requireSession(req: FastifyRequest): string {
    const sessionId = this.readSession(req);
    if (!sessionId)
      throw new HttpError(401, "NO_SESSION", "Open the app to start a local session.");
    if (MUTATING.has(req.method)) this.checkMutation(req, sessionId);
    return sessionId;
  }

  private checkMutation(req: FastifyRequest, sessionId: string): void {
    const origin = req.headers.origin;
    if (origin !== undefined && !this.opts.allowedOrigins.has(origin)) {
      throw new HttpError(403, "BAD_ORIGIN", "Cross-origin requests are not allowed.");
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "BAD_ORIGIN", "Cross-site requests are not allowed.");
    }
    const token = req.headers["x-csrf-token"];
    if (
      typeof token !== "string" ||
      !timingSafeEqualHex(token, hmacSha256Hex(this.csrfKey, sessionId))
    ) {
      throw new HttpError(403, "BAD_CSRF", "Missing or invalid CSRF token. Reload the page.");
    }
  }

  private readSession(req: FastifyRequest): string | null {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const i = raw.lastIndexOf(".");
    const sessionId = raw.slice(0, i);
    const mac = raw.slice(i + 1);
    if (i <= 0 || !timingSafeEqualHex(mac, hmacSha256Hex(this.sessionKey, sessionId))) return null;
    const issuedAt = Number(sessionId.slice(sessionId.lastIndexOf(".") + 1));
    if (!Number.isFinite(issuedAt) || this.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
    return sessionId;
  }
}
