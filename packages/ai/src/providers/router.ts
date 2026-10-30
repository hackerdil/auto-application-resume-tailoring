import {
  ProviderError,
  ProviderExecutionError,
  ProviderInvalidOutputError,
  ProviderPolicyError,
  ProviderUnavailableError,
  type ProviderName,
} from "@career-agent/domain";
import type {
  AIProvider,
  ProviderHealth,
  ProviderRequest,
  ProviderResult,
  TaskType,
} from "../types.js";

export type ProviderMode = "openai" | "claude" | "hybrid" | "compare" | "auto";

export interface RouterOptions {
  mode: ProviderMode;
  /** MAX_PROVIDER_RETRIES: retries per provider for rate-limit/timeout/unavailable errors. */
  maxRetries: number;
  baseDelayMs?: number;
  /** Consecutive failures that open the circuit, and how long it stays open. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called for every failed attempt (for provider_runs error rows); never given prompt or output text. */
  onFailure?: (provider: ProviderName, error: ProviderError, req: ProviderRequest) => void;
}

export interface ProviderHealthState {
  provider: ProviderName;
  configured: boolean;
  ok: boolean;
  reason: string | null;
  consecutiveFailures: number;
  /** Circuit open until this time (ISO) after repeated failures. */
  coolingDownUntil: string | null;
  lastErrorCode: string | null;
  lastSuccessAt: string | null;
}

/** Tasks where an independent second opinion matters: hybrid sends them to Claude first. */
const REVIEW_TASKS: ReadonlySet<TaskType> = new Set(["integrity_review"]);

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ProviderUnavailableError("openai", "Cancelled while waiting to retry."));
      },
      { once: true },
    );
  });

/**
 * Provider router (spec §8, Phase 9). Picks providers per task and mode, retries only retryable errors with
 * capped, jittered backoff, falls back across providers without cycles, and opens a short circuit after repeated
 * failures. Explicit "openai"/"claude" modes never fall back. "compare" currently routes like "hybrid".
 */
export class ProviderRouter implements AIProvider {
  private readonly state = new Map<ProviderName, ProviderHealthState>();

  constructor(
    private readonly providers: Partial<Record<ProviderName, AIProvider>>,
    private readonly opts: RouterOptions,
    private readonly unavailable: Partial<Record<ProviderName, string>> = {},
  ) {
    for (const p of ["openai", "claude"] as const)
      this.state.set(p, {
        provider: p,
        configured: !!providers[p],
        ok: !!providers[p],
        reason: providers[p] ? null : (unavailable[p] ?? "Not enabled."),
        consecutiveFailures: 0,
        coolingDownUntil: null,
        lastErrorCode: null,
        lastSuccessAt: null,
      });
  }

  get name(): ProviderName {
    return this.order("match_scoring")[0] ?? "openai";
  }

  /** True when at least one provider is configured. */
  get available(): boolean {
    return Object.values(this.providers).some(Boolean);
  }

  order(taskType: TaskType): ProviderName[] {
    const m = this.opts.mode;
    const base: ProviderName[] =
      m === "openai"
        ? ["openai"]
        : m === "claude"
          ? ["claude"]
          : (m === "hybrid" || m === "compare") && REVIEW_TASKS.has(taskType)
            ? ["claude", "openai"]
            : ["openai", "claude"];
    const now = this.now();
    const usable = base.filter((p) => this.providers[p]);
    if (m !== "auto") return usable;
    // auto: providers not cooling down first, in the base order.
    const cooling = (p: ProviderName) => {
      const until = this.state.get(p)?.coolingDownUntil;
      return until !== null && until !== undefined && Date.parse(until) > now;
    };
    return [...usable.filter((p) => !cooling(p)), ...usable.filter(cooling)];
  }

  async health(): Promise<ProviderHealth> {
    const report = await this.healthReport();
    return report.some((r) => r.ok)
      ? { ok: true }
      : {
          ok: false,
          reason: report.map((r) => `${r.provider}: ${r.reason ?? "unavailable"}`).join("; "),
        };
  }

  async healthReport(): Promise<ProviderHealthState[]> {
    const out: ProviderHealthState[] = [];
    for (const p of ["openai", "claude"] as const) {
      const s = { ...(this.state.get(p) as ProviderHealthState) };
      const provider = this.providers[p];
      if (provider) {
        const h = await provider
          .health()
          .catch(() => ({ ok: false as const, reason: "Health check failed." }));
        const cooling = s.coolingDownUntil !== null && Date.parse(s.coolingDownUntil) > this.now();
        s.ok = h.ok && !cooling;
        s.reason = !h.ok ? h.reason : cooling ? "Paused after repeated failures." : null;
      }
      out.push(s);
    }
    return out;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const order = this.order(req.taskType);
    if (!order.length)
      throw new ProviderUnavailableError("openai", "No AI provider is configured for this task.");
    const attempted: ProviderName[] = [];
    let last: ProviderError | null = null;
    const maxRetries = Math.min(this.opts.maxRetries, req.limits.maxRetries);
    for (const name of order) {
      if (attempted.includes(name)) continue;
      attempted.push(name);
      const provider = this.providers[name];
      if (!provider) continue;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await provider.run(req);
          this.succeeded(name);
          return { ...res, meta: { ...res.meta, fallback: attempted.length > 1 } };
        } catch (err) {
          const e =
            err instanceof ProviderError
              ? err
              : new ProviderExecutionError(name, "The AI request failed.", { cause: err });
          last = e;
          this.failed(name, e);
          this.opts.onFailure?.(name, e, req);
          if (req.signal.aborted) throw e;
          if (!e.retryable || attempt === maxRetries) break;
          const delay =
            Math.min(30_000, (this.opts.baseDelayMs ?? 1_000) * 2 ** attempt) *
            (0.5 + this.random() / 2);
          await (this.opts.sleep ?? defaultSleep)(delay, req.signal);
        }
      }
      // A refusal or output that would not validate is about the request, not the provider: do not shop around.
      if (last instanceof ProviderPolicyError || last instanceof ProviderInvalidOutputError)
        throw last;
    }
    throw last ?? new ProviderUnavailableError("openai", "No AI provider could run this task.");
  }

  private succeeded(p: ProviderName): void {
    const s = this.state.get(p);
    if (!s) return;
    s.consecutiveFailures = 0;
    s.coolingDownUntil = null;
    s.ok = true;
    s.reason = null;
    s.lastSuccessAt = new Date(this.now()).toISOString();
  }

  private failed(p: ProviderName, e: ProviderError): void {
    const s = this.state.get(p);
    if (!s) return;
    s.consecutiveFailures++;
    s.lastErrorCode = e.code;
    s.reason = e.message;
    if (s.consecutiveFailures >= (this.opts.breakerThreshold ?? 3)) {
      s.ok = false;
      s.coolingDownUntil = new Date(
        this.now() + (this.opts.breakerCooldownMs ?? 60_000),
      ).toISOString();
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private random(): number {
    return (this.opts.random ?? Math.random)();
  }
}
