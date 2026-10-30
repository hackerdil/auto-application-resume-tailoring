import type { AIProvider, ProviderHealth, ProviderRequest, ProviderResult } from "@career-agent/ai";
import { ProviderUnavailableError, type ProviderName } from "@career-agent/domain";

/** A literal output, a function computing the output from the request, or an Error to reject with. */
export type ScriptedStep = unknown;

/**
 * Deterministic provider for tests: returns scripted outputs in order and records every request.
 * Never touches the network.
 */
export class FakeProvider implements AIProvider {
  readonly requests: ProviderRequest[] = [];
  private step = 0;

  constructor(
    private readonly script: readonly ScriptedStep[],
    readonly name: ProviderName = "openai",
    private readonly healthy: ProviderHealth = { ok: true },
  ) {}

  health(): Promise<ProviderHealth> {
    return Promise.resolve(this.healthy);
  }

  run(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(request);
    const next = this.script[this.step++];
    if (next === undefined)
      return Promise.reject(
        new ProviderUnavailableError(this.name, "Fake provider script exhausted."),
      );
    if (next instanceof Error) return Promise.reject(next);
    const output =
      typeof next === "function" ? (next as (r: ProviderRequest) => unknown)(request) : next;
    return Promise.resolve({
      output,
      meta: {
        provider: this.name,
        model: "fake-model",
        traceId: request.traceId,
        requestId: `fake-${this.step}`,
        durationMs: 1,
        usage: { inputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 10 },
        costUsd: 0,
        toolCalls: 0,
        delegated: false,
        fallback: false,
      },
    });
  }
}
