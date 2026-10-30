import { mkdirSync } from "node:fs";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderAuthenticationError,
  ProviderError,
  ProviderExecutionError,
  ProviderInvalidOutputError,
  ProviderQuotaExceededError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "@career-agent/domain";
import type { AIProvider, ProviderHealth, ProviderRequest, ProviderResult } from "../types.js";
import { splitMessages } from "./openai.js";

export interface ClaudeAgentConfig {
  /** Empty dedicated directory (CLAUDE_WORKING_DIRECTORY); Claude has no file tools, this only pins the cwd. */
  workingDirectory: string;
  /** Leave unset to use the SDK default model. */
  model?: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

/** The query function, injectable so tests never start the real CLI or touch the owner's Claude login. */
export type QueryFn = typeof query;

/**
 * ADR-008 lockdown: no tools at all, no setting files, no session persistence, no MCP servers, and a minimal
 * environment that carries none of Career Agent's secrets. Authentication is the owner's own Claude Code login.
 */
export function lockedDownOptions(
  cfg: ClaudeAgentConfig,
  req: ProviderRequest,
  abortController: AbortController,
  systemPrompt: string,
): Options {
  return {
    tools: [],
    allowedTools: [],
    disallowedTools: [
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Read",
      "Glob",
      "Grep",
    ],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    strictMcpConfig: true,
    mcpServers: {},
    cwd: cfg.workingDirectory,
    maxTurns: Math.max(1, Math.min(cfg.maxTurns, req.limits.maxModelTurns)),
    maxBudgetUsd: Math.min(cfg.maxBudgetUsd, req.limits.maxCostUsd ?? cfg.maxBudgetUsd),
    outputFormat: { type: "json_schema", schema: req.outputJsonSchema },
    systemPrompt,
    abortController,
    env: minimalEnv(process.env),
    ...(cfg.model ? { model: cfg.model } : {}),
  };
}

/** PATH/HOME/locale only: never OPENAI_API_KEY, DATA_ENCRYPTION_KEY, LOCAL_SESSION_SECRET, or anything else. */
export function minimalEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = src[k];
    if (v) out[k] = v;
  }
  out["CLAUDE_AGENT_SDK_CLIENT_APP"] = "career-agent/0";
  return out;
}

export function mapClaudeResult(r: SDKResultMessage): ProviderError | null {
  if (r.subtype === "success" && !r.is_error) return null;
  if (r.subtype === "error_max_turns")
    return new ProviderExecutionError("claude", "Claude used all of its turns.");
  if (r.subtype === "error_max_budget_usd")
    return new ProviderQuotaExceededError("claude", "Claude reached the per-run budget.");
  if (r.subtype === "error_max_structured_output_retries")
    return new ProviderInvalidOutputError(
      "claude",
      "Claude could not produce valid structured output.",
    );
  const status = "api_error_status" in r ? r.api_error_status : null;
  if (status === 401 || status === 403)
    return new ProviderAuthenticationError(
      "claude",
      "Claude Code is not signed in. Run `claude` and log in.",
    );
  if (status === 429)
    return new ProviderRateLimitError("claude", "Claude plan limits reached; try later.");
  if (typeof status === "number" && status >= 500)
    return new ProviderUnavailableError("claude", `Claude is unavailable (HTTP ${status}).`);
  return new ProviderExecutionError("claude", "The Claude request failed.");
}

/**
 * Independent reviewer / fallback on the Claude Agent SDK in subscription mode (ADR-008). Pure reasoning over the
 * supplied JSON; the result is the SDK's validated `structured_output`.
 */
export class ClaudeAgentProvider implements AIProvider {
  readonly name = "claude" as const;

  constructor(
    private readonly cfg: ClaudeAgentConfig,
    private readonly queryFn: QueryFn = query,
  ) {}

  health(): Promise<ProviderHealth> {
    try {
      mkdirSync(this.cfg.workingDirectory, { recursive: true, mode: 0o700 });
      return Promise.resolve({ ok: true });
    } catch {
      return Promise.resolve({ ok: false, reason: "CLAUDE_WORKING_DIRECTORY cannot be created." });
    }
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    mkdirSync(this.cfg.workingDirectory, { recursive: true, mode: 0o700 });
    const { instructions, input } = splitMessages(req);
    const abort = new AbortController();
    const onAbort = () => {
      abort.abort();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, this.cfg.timeoutMs);
    let result: SDKResultMessage | null = null;
    let authError: string | null = null;
    try {
      const q = this.queryFn({
        prompt: input,
        options: lockedDownOptions(this.cfg, req, abort, instructions),
      });
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "auth_status" && m.error) authError = m.error;
        if (m.type === "result") result = m;
      }
    } catch (err) {
      if (abort.signal.aborted)
        throw new ProviderTimeoutError("claude", "Claude did not answer in time.", { cause: err });
      throw new ProviderUnavailableError("claude", "Claude Code could not be started.", {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
    }
    if (authError) throw new ProviderAuthenticationError("claude", "Claude Code is not signed in.");
    if (!result) throw new ProviderExecutionError("claude", "Claude returned no result.");
    const failure = mapClaudeResult(result);
    if (failure) throw failure;
    let output: unknown = "structured_output" in result ? result.structured_output : undefined;
    if (output === undefined && "result" in result) {
      try {
        output = JSON.parse(result.result);
      } catch {
        throw new ProviderInvalidOutputError("claude", "Claude returned text that is not JSON.");
      }
    }
    const usage = Object.values(result.modelUsage);
    const models = Object.keys(result.modelUsage);
    return {
      output,
      meta: {
        provider: "claude",
        model: models[0] ?? this.cfg.model ?? null,
        traceId: req.traceId,
        requestId: result.session_id,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
          cachedInputTokens: usage.reduce((n, u) => n + u.cacheReadInputTokens, 0),
          reasoningTokens: usage.reduce((n, u) => n + (u.thinkingTokens ?? 0), 0),
          outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
        },
        // An estimate from the SDK; in subscription mode it draws on plan limits rather than a bill.
        costUsd: result.total_cost_usd,
        toolCalls: 0,
        delegated: false,
        fallback: false,
      },
    };
  }
}
