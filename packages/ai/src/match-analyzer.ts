import type { MatchAnalyzer, ProviderRunRecord, RunBudget } from "@career-agent/domain";
import {
  MATCH_ANALYSIS_PROMPT,
  MatchAnalysisOutput,
  renderMatchAnalysis,
} from "./prompts/match-analysis.v1.js";
import { runStructured } from "./structured.js";
import type { AIProvider, ProviderRequest, ProviderResult } from "./types.js";

/**
 * Wraps a provider so every call is charged to the run budget (spec §4.5): a turn per call, the rendered
 * input size, and the reported cost. Exceeding any limit aborts the run with BudgetExceededError.
 */
export function budgeted(
  provider: AIProvider,
  budget: RunBudget,
  onRun: (r: ProviderResult, req: ProviderRequest) => void,
): AIProvider {
  return {
    name: provider.name,
    health: () => provider.health(),
    run: async (req) => {
      budget.use("modelTurns");
      budget.checkInput(req.messages.map((m) => m.content).join("\n"));
      const res = await provider.run({
        ...req,
        limits: budget.limits,
        signal: AbortSignal.any([req.signal, budget.signal]),
      });
      onRun(res, req);
      if (res.meta.costUsd !== null) budget.addCost(res.meta.costUsd);
      budget.checkAlive();
      return res;
    },
  };
}

/** The provider_runs row for one call (usage and cost only; never prompt or output text). */
export function runRecord(
  res: ProviderResult,
  req: ProviderRequest,
  agentRunId: string | null = null,
): ProviderRunRecord {
  return {
    traceId: req.traceId,
    agentRunId,
    provider: res.meta.provider,
    model: res.meta.model,
    taskType: req.taskType,
    promptId: req.promptId,
    promptVersion: req.promptVersion,
    requestId: res.meta.requestId,
    durationMs: res.meta.durationMs,
    inputTokens: res.meta.usage.inputTokens,
    cachedInputTokens: res.meta.usage.cachedInputTokens,
    reasoningTokens: res.meta.usage.reasoningTokens,
    outputTokens: res.meta.usage.outputTokens,
    costUsd: res.meta.costUsd,
    toolCalls: res.meta.toolCalls,
    delegated: res.meta.delegated,
    fallback: res.meta.fallback,
    errorClass: null,
  };
}

/** Records every successful call without a run budget (callers that bound work by other means, e.g. extraction). */
export function recorded(
  provider: AIProvider,
  onRecord: (r: ProviderRunRecord) => void,
): AIProvider {
  return {
    name: provider.name,
    health: () => provider.health(),
    run: async (req) => {
      const res = await provider.run(req);
      onRecord(runRecord(res, req));
      return res;
    },
  };
}

export interface MatchAnalyzerOptions {
  maxFacts?: number;
  /** Exact secret values that must never appear in prompts. */
  secretValues?: readonly string[];
}

export function createMatchAnalyzer(
  provider: AIProvider,
  opts: MatchAnalyzerOptions = {},
): MatchAnalyzer {
  return {
    provider: provider.name,
    async analyze(input, ctx) {
      const runs: ProviderRunRecord[] = [];
      let model: string | null = null;
      const wrapped = budgeted(provider, ctx.budget, (res, req) => {
        model = res.meta.model;
        runs.push({
          traceId: ctx.traceId,
          agentRunId: null,
          provider: res.meta.provider,
          model: res.meta.model,
          taskType: req.taskType,
          promptId: req.promptId,
          promptVersion: req.promptVersion,
          requestId: res.meta.requestId,
          durationMs: res.meta.durationMs,
          inputTokens: res.meta.usage.inputTokens,
          cachedInputTokens: res.meta.usage.cachedInputTokens,
          reasoningTokens: res.meta.usage.reasoningTokens,
          outputTokens: res.meta.usage.outputTokens,
          costUsd: res.meta.costUsd,
          toolCalls: res.meta.toolCalls,
          delegated: res.meta.delegated,
          fallback: res.meta.fallback,
          errorClass: null,
        });
      });
      const out = await runStructured({
        provider: wrapped,
        taskType: "match_scoring",
        prompt: MATCH_ANALYSIS_PROMPT,
        messages: renderMatchAnalysis({
          job: input.job,
          requirements: input.requirements,
          facts: input.facts.slice(0, opts.maxFacts ?? 80),
        }),
        schema: MatchAnalysisOutput,
        limits: ctx.budget.limits,
        signal: ctx.budget.signal,
        traceId: ctx.traceId,
        ...(opts.secretValues ? { secretValues: opts.secretValues } : {}),
      });
      return {
        judgments: out.value.requirements,
        explanation: out.value.explanation,
        promptId: MATCH_ANALYSIS_PROMPT.id,
        promptVersion: MATCH_ANALYSIS_PROMPT.version,
        model,
        runs,
      };
    },
  };
}
