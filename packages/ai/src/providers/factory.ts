import path from "node:path";
import type { ProviderName, ProviderRunRepository } from "@career-agent/domain";
import { ClaudeAgentProvider } from "./claude.js";
import { OpenAIAgentsProvider, type TokenPricing } from "./openai.js";
import { ProviderRouter, type ProviderMode, type RouterOptions } from "./router.js";

/** The provider settings from config (packages/config), passed as plain values. */
export interface ProviderSettings {
  mode: ProviderMode;
  timeoutMs: number;
  maxRetries: number;
  onFailure?: RouterOptions["onFailure"];
  openai: {
    enabled: boolean;
    ready: boolean;
    reason?: string;
    apiKey?: string | undefined;
    model?: string | undefined;
    maxTurns: number;
    pricing?: TokenPricing | null;
  };
  claude: {
    enabled: boolean;
    model?: string | undefined;
    workingDirectory: string;
    maxTurns: number;
    maxBudgetUsd: number;
  };
}

export interface AIProviders {
  router: ProviderRouter;
  openai: OpenAIAgentsProvider | null;
  claude: ClaudeAgentProvider | null;
}

/**
 * Builds the configured providers and the router. Nothing here contacts a provider: OpenAI is only constructed
 * with a key and model, and Claude starts its CLI on the first request.
 */
export function createAIProviders(s: ProviderSettings): AIProviders {
  const openai =
    s.openai.enabled && s.openai.ready && s.openai.apiKey && s.openai.model
      ? new OpenAIAgentsProvider({
          apiKey: s.openai.apiKey,
          model: s.openai.model,
          maxTurns: s.openai.maxTurns,
          timeoutMs: s.timeoutMs,
          pricing: s.openai.pricing ?? null,
        })
      : null;
  const claude = s.claude.enabled
    ? new ClaudeAgentProvider({
        workingDirectory: path.resolve(s.claude.workingDirectory),
        model: s.claude.model ?? null,
        maxTurns: s.claude.maxTurns,
        maxBudgetUsd: s.claude.maxBudgetUsd,
        timeoutMs: s.timeoutMs,
      })
    : null;
  const unavailable: Partial<Record<ProviderName, string>> = {};
  if (!openai)
    unavailable.openai = s.openai.enabled
      ? (s.openai.reason ?? "Not configured.")
      : "Disabled (OPENAI_ENABLED=false).";
  if (!claude) unavailable.claude = "Disabled (CLAUDE_ENABLED=false).";
  const router = new ProviderRouter(
    { ...(openai ? { openai } : {}), ...(claude ? { claude } : {}) },
    { mode: s.mode, maxRetries: s.maxRetries, ...(s.onFailure ? { onFailure: s.onFailure } : {}) },
    unavailable,
  );
  return { router, openai, claude };
}

/** Records each failed attempt as a provider_runs row with its error class (no prompt or output text). */
export function failureRecorder(
  runs: ProviderRunRepository,
): NonNullable<RouterOptions["onFailure"]> {
  return (provider, error, req) => {
    runs.record({
      traceId: req.traceId,
      agentRunId: null,
      provider,
      model: null,
      taskType: req.taskType,
      promptId: req.promptId,
      promptVersion: req.promptVersion,
      requestId: null,
      durationMs: 0,
      inputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      outputTokens: null,
      costUsd: null,
      toolCalls: 0,
      delegated: false,
      fallback: false,
      errorClass: error.code,
    });
  };
}
