import { BudgetExceededError } from "./errors.js";
import type { RunLimits } from "./schemas/run.js";

type Counter = "modelTurns" | "toolCalls" | "browserSteps" | "retries";

const LIMIT_FOR: Record<Counter, keyof RunLimits> = {
  modelTurns: "maxModelTurns",
  toolCalls: "maxToolCalls",
  browserSteps: "maxBrowserSteps",
  retries: "maxRetries",
};

/**
 * Tracks a run's consumption against its limits. Every check throws BudgetExceededError and aborts the
 * run's signal so in-flight work stops (spec §4.5).
 */
export class RunBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly counts: Record<Counter, number> = {
    modelTurns: 0,
    toolCalls: 0,
    browserSteps: 0,
    retries: 0,
  };
  private costUsd = 0;

  constructor(
    readonly limits: RunLimits,
    parent?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {
    this.deadlineAt = now() + limits.deadlineMs;
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal;
  }

  use(counter: Counter, n = 1): void {
    this.checkAlive();
    const next = this.counts[counter] + n;
    const max = this.limits[LIMIT_FOR[counter]] as number;
    if (next > max) this.fail(LIMIT_FOR[counter]);
    this.counts[counter] = next;
  }

  addCost(usd: number): void {
    this.checkAlive();
    this.costUsd += usd;
    if (this.limits.maxCostUsd !== null && this.costUsd > this.limits.maxCostUsd)
      this.fail("maxCostUsd");
  }

  checkInput(text: string): void {
    if (text.length > this.limits.maxInputChars) this.fail("maxInputChars");
  }

  checkAlive(): void {
    if (this.signal.aborted) throw new BudgetExceededError("aborted", "Run was aborted.");
    if (this.now() > this.deadlineAt) this.fail("deadlineMs");
  }

  abort(reason = "cancelled"): void {
    this.controller.abort(new BudgetExceededError(reason, `Run ${reason}.`));
  }

  /**
   * Limits for the next provider call: what is left of this run's turns and cost, so a single call (for example
   * Claude's maxBudgetUsd) can never spend more than the run has remaining.
   */
  remaining(): RunLimits {
    return {
      ...this.limits,
      maxModelTurns: Math.max(1, this.limits.maxModelTurns - this.counts.modelTurns + 1),
      maxCostUsd:
        this.limits.maxCostUsd === null ? null : Math.max(0, this.limits.maxCostUsd - this.costUsd),
    };
  }

  snapshot() {
    return { ...this.counts, costUsd: this.costUsd };
  }

  private fail(limit: string): never {
    const err = new BudgetExceededError(limit);
    this.controller.abort(err);
    throw err;
  }
}
