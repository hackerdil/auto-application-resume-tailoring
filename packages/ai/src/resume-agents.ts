import type {
  IntegrityReviewer,
  ProviderRunRecord,
  ResumeGenerator,
  RunBudget,
} from "@career-agent/domain";
import { budgeted } from "./match-analyzer.js";
import {
  INTEGRITY_REVIEW_PROMPT,
  IntegrityReviewOutput,
  renderIntegrityReview,
} from "./prompts/integrity-review.v1.js";
import {
  RESUME_REVISION_PROMPT,
  renderResumeRevision,
  RevisionOutput,
} from "./prompts/resume-revision.v1.js";
import {
  RESUME_TAILORING_PROMPT,
  renderResumeTailoring,
  TailoringOutput,
} from "./prompts/resume-tailoring.v1.js";
import { runStructured } from "./structured.js";
import type { AIProvider, TaskType } from "./types.js";

function recorder(traceId: string) {
  const runs: ProviderRunRecord[] = [];
  const onRun = (
    res: Awaited<ReturnType<AIProvider["run"]>>,
    req: Parameters<AIProvider["run"]>[0],
  ) => {
    runs.push({
      traceId,
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
  };
  return { runs, onRun };
}

async function call<T extends Parameters<typeof runStructured>[0]["schema"]>(
  provider: AIProvider,
  budget: RunBudget,
  traceId: string,
  taskType: TaskType,
  prompt: { id: string; version: string },
  messages: Parameters<typeof runStructured>[0]["messages"],
  schema: T,
) {
  const rec = recorder(traceId);
  const out = await runStructured({
    provider: budgeted(provider, budget, rec.onRun),
    taskType,
    prompt,
    messages,
    schema,
    limits: budget.limits,
    signal: budget.signal,
    traceId,
  });
  return { value: out.value, runs: rec.runs };
}

export function createResumeGenerator(provider: AIProvider): ResumeGenerator {
  return {
    name: provider.name,
    async generate(input, ctx) {
      const r = await call(
        provider,
        ctx.budget,
        ctx.traceId,
        "resume_tailoring",
        RESUME_TAILORING_PROMPT,
        renderResumeTailoring(input),
        TailoringOutput,
      );
      return {
        summary: r.value.summary,
        bullets: r.value.bullets,
        runs: r.runs,
        promptId: `${RESUME_TAILORING_PROMPT.id}@${RESUME_TAILORING_PROMPT.version}`,
      };
    },
    async revise(input, ctx) {
      const r = await call(
        provider,
        ctx.budget,
        ctx.traceId,
        "resume_tailoring",
        RESUME_REVISION_PROMPT,
        renderResumeRevision(input),
        RevisionOutput,
      );
      return {
        revised: r.value.revised,
        runs: r.runs,
        promptId: `${RESUME_REVISION_PROMPT.id}@${RESUME_REVISION_PROMPT.version}`,
      };
    },
  };
}

export function createIntegrityReviewer(provider: AIProvider): IntegrityReviewer {
  return {
    name: provider.name,
    async review(input, ctx) {
      const r = await call(
        provider,
        ctx.budget,
        ctx.traceId,
        "integrity_review",
        INTEGRITY_REVIEW_PROMPT,
        renderIntegrityReview(input.items),
        IntegrityReviewOutput,
      );
      return {
        verdicts: r.value.verdicts,
        runs: r.runs,
        promptId: `${INTEGRITY_REVIEW_PROMPT.id}@${INTEGRITY_REVIEW_PROMPT.version}`,
      };
    },
  };
}
