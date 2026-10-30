import type { BrowserContext, Route } from "playwright";
import { isPublicIp } from "@career-agent/security";

export interface BrowserPolicy {
  /** Origins the top-level page may navigate to (the application's ATS origin(s)). */
  allowedOrigins: readonly string[];
  /** Extra origins allowed only inside iframes (embedded forms, CAPTCHA widgets the owner solves). */
  subframeOrigins: readonly string[];
  /** URL patterns whose non-GET requests are blocked while preparing (adapter-specific submit endpoints). */
  blockedWritePatterns: readonly RegExp[];
  /** Local fixture servers in tests only. */
  allowPrivateNetwork: boolean;
}

export type BlockedReason =
  | "navigation_off_allowlist"
  | "frame_off_allowlist"
  | "form_submission"
  | "submit_endpoint"
  | "scheme"
  | "private_network";

export interface BlockedRequest {
  reason: BlockedReason;
  url: string;
  method: string;
  at: string;
}

/** Common CAPTCHA/anti-bot widget origins. They may load (the owner solves them); Career Agent never interacts. */
export const CHALLENGE_FRAME_ORIGINS = [
  "https://www.google.com",
  "https://www.recaptcha.net",
  "https://hcaptcha.com",
  "https://newassets.hcaptcha.com",
  "https://challenges.cloudflare.com",
];

const isPrivateHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  )
    return true;
  return /^[\d.]+$|:/.test(h) ? !isPublicIp(h) : false;
};

/**
 * Network guard for an application's browser context (docs/THREAT_MODEL.md T11). Applied to every request in
 * every page and frame of the context:
 * - only http(s) (plus data:/blob: subresources);
 * - top-level navigations only to allowed origins; subframes to allowed or challenge-widget origins;
 * - non-GET document navigations (classic form submits) and adapter submit endpoints are blocked while preparing,
 *   so no model or code path can submit by accident — the deterministic submission service (Phase 8) uses its own context;
 * - private-network destinations are blocked unless explicitly allowed for local fixtures.
 */
export async function installRouteGuard(
  context: BrowserContext,
  policy: BrowserPolicy,
  onBlocked: (b: BlockedRequest) => void,
): Promise<void> {
  const allowed = new Set(policy.allowedOrigins);
  const frames = new Set([...policy.allowedOrigins, ...policy.subframeOrigins]);
  const block = async (route: Route, reason: BlockedReason) => {
    const req = route.request();
    onBlocked({
      reason,
      url: req.url().slice(0, 300),
      method: req.method(),
      at: new Date().toISOString(),
    });
    await route.abort("blockedbyclient");
  };
  await context.route("**/*", (route) =>
    // Fail closed: any error while deciding aborts the request.
    decide(route).catch(() => route.abort("blockedbyclient").catch(() => undefined)),
  );
  async function decide(route: Route): Promise<void> {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return block(route, "scheme");
    }
    if (url.protocol === "data:" || url.protocol === "blob:")
      return req.isNavigationRequest() ? block(route, "scheme") : route.continue();
    if (url.protocol !== "https:" && url.protocol !== "http:") return block(route, "scheme");
    if (!policy.allowPrivateNetwork && isPrivateHost(url.hostname))
      return block(route, "private_network");
    if (url.protocol === "http:" && !policy.allowPrivateNetwork) return block(route, "scheme");
    const method = req.method().toUpperCase();
    if (req.isNavigationRequest()) {
      // Popup navigations have no frame yet; treat them as top-level (the stricter rule).
      let main: boolean;
      try {
        main = req.frame().parentFrame() === null;
      } catch {
        main = true;
      }
      if (main && !allowed.has(url.origin)) return block(route, "navigation_off_allowlist");
      if (!main && !frames.has(url.origin)) return block(route, "frame_off_allowlist");
      if (method !== "GET") return block(route, "form_submission");
    }
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      policy.blockedWritePatterns.some((re) => re.test(req.url()))
    )
      return block(route, "submit_endpoint");
    return route.continue();
  }
}
