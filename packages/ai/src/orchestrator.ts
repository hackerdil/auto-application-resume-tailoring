import { tool, type JsonSchemaDefinition, type Tool } from "@openai/agents-core";
import { z } from "zod";
import { RunBudget, type ProviderRunRecord, type RunLimits } from "@career-agent/domain";
import { redact } from "@career-agent/security";
import { DELEGATION_PROMPT, DelegationOutput, renderDelegation } from "./prompts/delegation.v1.js";
import type { OpenAIAgentsProvider } from "./providers/openai.js";
import { budgeted } from "./match-analyzer.js";
import { runStructured } from "./structured.js";
import type {
  AIProvider,
  PromptMessage,
  ProviderRequest,
  ProviderRunMeta,
  TaskType,
} from "./types.js";

/** A capability the orchestrator may use. Inputs are validated again by the tool's own implementation. */
export interface OrchestratorTool {
  name: string;
  description: string;
  input: z.ZodType;
  call(input: unknown): Promise<unknown>;
}

export interface OrchestrateOptions<T extends z.ZodType> {
  openai: OpenAIAgentsProvider;
  /** Independent reviewer for delegate_to_claude; null disables delegation. */
  claude: AIProvider | null;
  maxDelegations: number;
  tools: readonly OrchestratorTool[];
  taskType: TaskType;
  prompt: { id: string; version: string };
  messages: PromptMessage[];
  schema: T;
  limits: RunLimits;
  signal: AbortSignal;
  traceId: string;
  secretValues?: readonly string[];
  onRun?: (r: ProviderRunRecord) => void;
}

const record = (
  traceId: string,
  taskType: TaskType,
  prompt: { id: string; version: string },
  meta: ProviderRunMeta,
): ProviderRunRecord => ({
  traceId,
  agentRunId: null,
  provider: meta.provider,
  model: meta.model,
  taskType,
  promptId: prompt.id,
  promptVersion: prompt.version,
  requestId: meta.requestId,
  durationMs: meta.durationMs,
  inputTokens: meta.usage.inputTokens,
  cachedInputTokens: meta.usage.cachedInputTokens,
  reasoningTokens: meta.usage.reasoningTokens,
  outputTokens: meta.usage.outputTokens,
  costUsd: meta.costUsd,
  toolCalls: meta.toolCalls,
  delegated: meta.delegated,
  fallback: meta.fallback,
  errorClass: null,
});

const TOOL_ERROR_TEXT: Record<string, string> = {
  POLICY: "Refused by Career Agent's safety rules. Ask the owner instead.",
  VALIDATION: "Invalid input or an outdated handle. Call inspect_page again.",
  BUDGET_EXCEEDED: "This run has used its budget. Stop and report.",
};

/** Our error code, also when the SDK wraps the tool's error as its cause. */
function errorCode(err: unknown): string {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 3; e = e.cause, i++)
    if ("code" in e && typeof e.code === "string") return e.code;
  return "";
}

type NonStrictSchema = Extract<JsonSchemaDefinition["schema"], { additionalProperties: true }>;

/** Non-strict function-tool parameters from a Zod object schema; the tool re-validates every input. */
export function toolParameters(schema: z.ZodType): NonStrictSchema {
  const js = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return {
    type: "object",
    properties: js.properties ?? {},
    required: js.required ?? [],
    additionalProperties: true,
  };
}

/**
 * OpenAI orchestrator (ADR-009, spec §8): an Agents SDK run whose only tools are the ones passed in plus
 * delegate_to_claude, capped at `maxDelegations` per run. Tool errors are returned to the model as short safe
 * messages; the run budget bounds turns, tool calls, time, and cost.
 */
export async function orchestrate<T extends z.ZodType>(
  o: OrchestrateOptions<T>,
): Promise<{ value: z.infer<T>; delegations: number; toolCalls: number }> {
  const budget = new RunBudget(o.limits, o.signal);
  let delegations = 0;
  let toolCalls = 0;
  const wrap = (t: OrchestratorTool): Tool =>
    tool({
      name: t.name,
      description: t.description,
      parameters: toolParameters(t.input),
      strict: false,
      execute: async (input: unknown) => {
        budget.use("toolCalls");
        toolCalls++;
        const out = await t.call(input);
        return JSON.stringify(redact(out, { extraValues: o.secretValues ?? [] })).slice(0, 20_000);
      },
      // Fixed text per error class: no raw messages (paths, page text) reach the model.
      errorFunction: (_ctx, err) => TOOL_ERROR_TEXT[errorCode(err)] ?? "The tool failed.",
    });

  const delegate: OrchestratorTool = {
    name: "delegate_to_claude",
    description: "Ask an independent reviewer (Claude) for a second opinion. Advice only.",
    input: z.object({
      question: z.string().min(1).max(2_000),
      context: z.string().max(10_000).default(""),
    }),
    call: async (raw) => {
      if (!o.claude) return { refused: "Delegation is not available." };
      if (delegations >= o.maxDelegations)
        return { refused: "The delegation limit for this run is reached." };
      const input = z
        .object({
          question: z.string().min(1).max(2_000),
          context: z.string().max(10_000).default(""),
        })
        .parse(raw);
      delegations++;
      const reviewer = budgeted(o.claude, budget, (res, req) => {
        o.onRun?.(
          record(o.traceId, req.taskType, DELEGATION_PROMPT, { ...res.meta, delegated: true }),
        );
      });
      const out = await runStructured({
        provider: reviewer,
        taskType: "integrity_review",
        prompt: DELEGATION_PROMPT,
        messages: renderDelegation(input.question, input.context),
        schema: DelegationOutput,
        limits: budget.limits,
        signal: budget.signal,
        traceId: o.traceId,
        ...(o.secretValues ? { secretValues: o.secretValues } : {}),
      });
      return out.value;
    },
  };
  const tools = [...o.tools, delegate].map(wrap);

  // The orchestrator's own turn goes through the same budget and run records as every other model call.
  const orchestrator = budgeted(
    {
      name: "openai",
      health: () => o.openai.health(),
      run: (req: ProviderRequest) => o.openai.run(req, tools),
    },
    budget,
    (res, req) => {
      o.onRun?.(record(o.traceId, req.taskType, o.prompt, res.meta));
    },
    // A failed orchestrator run still leaves a provider_runs row (the router's failure recorder is not in path).
    (err, req) => {
      o.onRun?.({
        ...record(o.traceId, req.taskType, o.prompt, {
          provider: "openai",
          model: o.openai.cfg.model,
          traceId: o.traceId,
          requestId: null,
          durationMs: 0,
          usage: {
            inputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
            outputTokens: null,
          },
          costUsd: null,
          toolCalls,
          delegated: false,
          fallback: false,
        }),
        errorClass: err instanceof Error && "code" in err ? String(err.code) : "error",
      });
    },
  );
  const out = await runStructured({
    provider: orchestrator,
    taskType: o.taskType,
    prompt: o.prompt,
    messages: o.messages,
    schema: o.schema,
    limits: budget.limits,
    signal: budget.signal,
    traceId: o.traceId,
    ...(o.secretValues ? { secretValues: o.secretValues } : {}),
  });
  return { value: out.value, delegations, toolCalls };
}
