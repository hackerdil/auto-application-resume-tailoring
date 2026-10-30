import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { sha256Hex } from "@career-agent/security";
import { installRouteGuard, type BlockedRequest, type BrowserPolicy } from "./policy.js";

export interface SessionOptions {
  policy: BrowserPolicy;
  headless: boolean;
  /** Persistent per-origin profile directory root (keeps the owner's ATS logins). Omit for a throwaway context. */
  profileRoot?: string;
  /** Total session lifetime. */
  maxDurationMs: number;
}

export interface SessionEvent {
  at: string;
  type: "blocked" | "popup_closed" | "download_blocked" | "dialog_dismissed" | "navigated";
  detail: string;
}

/**
 * One application's isolated, visible browser (spec §13 session policy): its own context (or per-origin persistent
 * profile under BROWSER_PROFILE_DIR, never the owner's everyday browser), network guard installed before any page
 * loads, popups closed, downloads refused, dialogs dismissed, and a hard lifetime.
 */
export class BrowserSession {
  readonly events: SessionEvent[] = [];
  readonly blocked: BlockedRequest[] = [];
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly browser: Browser | null,
    maxDurationMs: number,
  ) {
    this.timer = setTimeout(() => void this.close(), maxDurationMs);
    this.timer.unref();
  }

  static async open(opts: SessionOptions): Promise<BrowserSession> {
    const launch = {
      headless: opts.headless,
      args: ["--disable-features=AutofillServerCommunication"],
    };
    const contextOptions = {
      acceptDownloads: false,
      serviceWorkers: "block" as const,
      bypassCSP: false,
      javaScriptEnabled: true,
    };
    let context: BrowserContext;
    let browser: Browser | null = null;
    const withFallback = async <T>(fn: (channel?: string) => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof Error && /Executable doesn't exist/i.test(err.message))
          return fn("chrome");
        throw err;
      }
    };
    if (opts.profileRoot) {
      const origin = opts.policy.allowedOrigins[0] ?? "default";
      const dir = path.join(opts.profileRoot, sha256Hex(origin).slice(0, 16));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      context = await withFallback((channel) =>
        chromium.launchPersistentContext(dir, {
          ...launch,
          ...contextOptions,
          ...(channel ? { channel } : {}),
        }),
      );
    } else {
      browser = await withFallback((channel) =>
        chromium.launch({ ...launch, ...(channel ? { channel } : {}) }),
      );
      context = await browser.newContext(contextOptions);
    }
    const holder: { s?: BrowserSession } = {};
    await installRouteGuard(context, opts.policy, (b) => {
      holder.s?.blocked.push(b);
      holder.s?.events.push({
        at: b.at,
        type: "blocked",
        detail: `${b.reason}: ${b.method} ${b.url}`,
      });
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const s = new BrowserSession(context, page, browser, opts.maxDurationMs);
    holder.s = s;
    context.on("page", (p) => {
      if (p === page) return;
      s.events.push({
        at: new Date().toISOString(),
        type: "popup_closed",
        detail: "A new window was blocked.",
      });
      void p.close();
    });
    page.on("download", (d) => {
      s.events.push({
        at: new Date().toISOString(),
        type: "download_blocked",
        detail: d.suggestedFilename().slice(0, 100),
      });
      void d.cancel();
    });
    page.on("dialog", (d) => {
      s.events.push({ at: new Date().toISOString(), type: "dialog_dismissed", detail: d.type() });
      void d.dismiss();
    });
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame())
        s.events.push({
          at: new Date().toISOString(),
          type: "navigated",
          detail: new URL(f.url()).origin,
        });
    });
    return s;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.context.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
