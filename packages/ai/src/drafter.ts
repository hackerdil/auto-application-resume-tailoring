import type {
  ApplicationDrafter,
  DraftSegment,
  ProviderRunRecord,
  RunBudget,
} from "@career-agent/domain";
import { budgeted } from "./match-analyzer.js";
import {
  APPLICATION_ANSWERS_PROMPT,
  ApplicationAnswersOutput,
  COVER_LETTER_PROMPT,
  CoverLetterOutput,
  renderApplicationAnswers,
  renderCoverLetter,
  renderSegmentRevision,
  SEGMENT_REVISION_PROMPT,
  SegmentRevisionOutput,
} from "./prompts/application-drafting.v1.js";
import { runStructured } from "./structured.js";
import type { AIProvider, PromptMessage } from "./types.js";

async function run<T extends Parameters<typeof runStructured>[0]["schema"]>(
  provider: AIProvider,
  budget: RunBudget,
  traceId: string,
  prompt: { id: string; version: string },
  messages: PromptMessage[],
  schema: T,
) {
  const runs: ProviderRunRecord[] = [];
  const wrapped = budgeted(provider, budget, (res, req) => {
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
  });
  const out = await runStructured({
    provider: wrapped,
    taskType: "application_drafting",
    prompt,
    messages,
    schema,
    limits: budget.limits,
    signal: budget.signal,
    traceId,
  });
  return { value: out.value, runs, promptId: `${prompt.id}@${prompt.version}` };
}

const seg = (s: {
  kind: "fact" | "motivation";
  text: string;
  factIds: string[];
  transformation: DraftSegment["transformation"];
}): DraftSegment => ({
  kind: s.kind,
  text: s.text,
  factIds: s.factIds,
  transformation: s.transformation,
});

export function createApplicationDrafter(provider: AIProvider): ApplicationDrafter {
  return {
    name: provider.name,
    async draftCoverLetter(input, ctx) {
      const r = await run(
        provider,
        ctx.budget,
        ctx.traceId,
        COVER_LETTER_PROMPT,
        renderCoverLetter(input),
        CoverLetterOutput,
      );
      return {
        paragraphs: r.value.paragraphs.map((p) => p.map(seg)),
        runs: r.runs,
        promptId: r.promptId,
      };
    },
    async draftAnswers(input, ctx) {
      const r = await run(
        provider,
        ctx.budget,
        ctx.traceId,
        APPLICATION_ANSWERS_PROMPT,
        renderApplicationAnswers(input),
        ApplicationAnswersOutput,
      );
      return {
        answers: r.value.answers.map((a) => ({
          fieldId: a.fieldId,
          segments: a.segments.map(seg),
        })),
        runs: r.runs,
        promptId: r.promptId,
      };
    },
    async reviseSegment(input, ctx) {
      const r = await run(
        provider,
        ctx.budget,
        ctx.traceId,
        SEGMENT_REVISION_PROMPT,
        renderSegmentRevision(input),
        SegmentRevisionOutput,
      );
      return {
        revised: r.value.revised ? seg(r.value.revised) : null,
        runs: r.runs,
        promptId: r.promptId,
      };
    },
  };
}
