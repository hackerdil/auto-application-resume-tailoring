import {
  Agent,
  MaxTurnsExceededError,
  ModelRefusalError,
  ModelTimeoutError,
  Runner,
  type JsonSchemaDefinition,
  type ModelProvider,
  type Tool,
} from "@openai/agents-core";
import { OpenAIProvider } from "@openai/agents-openai";
import {
  ProviderAuthenticationError,
  ProviderError,
  ProviderExecutionError,
  ProviderInvalidOutputError,
  ProviderPolicyError,
  ProviderQuotaExceededError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "@career-agent/domain";
import type { AIProvider, ProviderHealth, ProviderRequest, ProviderResult } from "../types.js";

export interface TokenPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface OpenAIAgentsConfig {
  apiKey: string;
  /** From OPENAI_MODEL only; never a hardcoded default (ADR-009). */
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** Optional pricing for cost accounting; without it cost is unknown and turns/input size bound spend (ADR-025). */
  pricing?: TokenPricing | null;
}

/** Splits our provider-neutral messages into agent instructions and user input. */
export function splitMessages(req: Pick<ProviderRequest, "messages">): {
  instructions: string;
  input: string;
} {
  return {
    instructions: req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n"),
    input: req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n"),
  };
}

export const costFor = (
  pricing: TokenPricing | null | undefined,
  input: number,
  output: number,
): number | null =>
  pricing ? (input * pricing.inputPerMTok + output * pricing.outputPerMTok) / 1_000_000 : null;

/** Maps OpenAI SDK / Agents SDK errors to provider errors (spec §8). Never forwards raw response bodies. */
export function mapOpenAIError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof MaxTurnsExceededError)
    return new ProviderExecutionError("openai", "The model used all of its turns.");
  if (err instanceof ModelRefusalError)
    return new ProviderPolicyError("openai", "The model refused the request.");
  if (err instanceof ModelTimeoutError)
    return new ProviderTimeoutError("openai", "The model did not answer in time.");
  const e = err as { status?: unknown; code?: unknown; name?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : null;
  const code = typeof e?.code === "string" ? e.code : "";
  const name = typeof e?.name === "string" ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError" || /Timeout/i.test(name))
    return new ProviderTimeoutError("openai", "The OpenAI request timed out or was cancelled.");
  if (status === 401 || status === 403)
    return new ProviderAuthenticationError("openai", "OpenAI rejected the API key.");
  if (status === 429 && code === "insufficient_quota")
    return new ProviderQuotaExceededError("openai", "The OpenAI account has no quota left.");
  if (status === 429)
    return new ProviderRateLimitError("openai", "OpenAI is rate limiting requests.");
  if (status !== null && status >= 500)
    return new ProviderUnavailableError("openai", `OpenAI is unavailable (HTTP ${status}).`);
  if (/Connection/i.test(name))
    return new ProviderUnavailableError("openai", "OpenAI could not be reached.");
  return new ProviderExecutionError("openai", "The OpenAI request failed.");
}

/**
 * Structured-output provider on the OpenAI Agents SDK (ADR-009). Tracing export is disabled: prompts contain the
 * owner's facts. Tools are only ever the ones a caller passes explicitly (the orchestrator); plain structured
 * tasks run with none.
 */
export class OpenAIAgentsProvider implements AIProvider {
  readonly name = "openai" as const;
  readonly runner: Runner;

  constructor(
    readonly cfg: OpenAIAgentsConfig,
    deps: { modelProvider?: ModelProvider } = {},
  ) {
    this.runner = new Runner({
      modelProvider: deps.modelProvider ?? new OpenAIProvider({ apiKey: cfg.apiKey }),
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve(
      this.cfg.apiKey && this.cfg.model
        ? { ok: true }
        : { ok: false, reason: "Set OPENAI_API_KEY and OPENAI_MODEL to use OpenAI." },
    );
  }

  async run(req: ProviderRequest, tools: Tool[] = []): Promise<ProviderResult> {
    const started = Date.now();
    const { instructions, input } = splitMessages(req);
    const outputType: JsonSchemaDefinition = {
      type: "json_schema",
      name: req.promptId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      strict: false,
      schema: req.outputJsonSchema as JsonSchemaDefinition["schema"],
    };
    const agent = new Agent({
      name: req.promptId,
      instructions,
      model: this.cfg.model,
      outputType,
      tools,
    });
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(this.cfg.timeoutMs)]);
    try {
      const result = await this.runner.run(agent, input, {
        maxTurns: Math.min(this.cfg.maxTurns, req.limits.maxModelTurns),
        signal,
      });
      const usage = result.runContext.usage;
      const raw: unknown = result.finalOutput;
      let output: unknown = raw;
      if (typeof raw === "string") {
        try {
          output = JSON.parse(raw);
        } catch {
          throw new ProviderInvalidOutputError("openai", "OpenAI returned text that is not JSON.");
        }
      }
      return {
        output,
        meta: {
          provider: "openai",
          model: this.cfg.model,
          traceId: req.traceId,
          requestId: result.lastResponseId ?? null,
          durationMs: Date.now() - started,
          usage: {
            inputTokens: usage.inputTokens,
            cachedInputTokens: sumDetail(usage.inputTokensDetails, "cached_tokens"),
            reasoningTokens: sumDetail(usage.outputTokensDetails, "reasoning_tokens"),
            outputTokens: usage.outputTokens,
          },
          costUsd: costFor(this.cfg.pricing, usage.inputTokens, usage.outputTokens),
          toolCalls: result.newItems.filter((i) => i.type === "tool_call_item").length,
          delegated: false,
          fallback: false,
        },
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

function sumDetail(details: readonly Record<string, unknown>[], key: string): number | null {
  let total = 0;
  let seen = false;
  for (const d of details) {
    const v = d[key];
    if (typeof v === "number") {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}
