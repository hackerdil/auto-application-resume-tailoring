import type { ProviderRunRecord } from "../repositories.js";
import type { RunBudget } from "../run-budget.js";
import type { FactTransformation } from "../schemas/fact.js";
import type { CoverLetter } from "../schemas/resume.js";
import type { GeneratorFact, RenderCheck } from "../tailoring/ports.js";

export interface DraftSegment {
  kind: "fact" | "motivation";
  text: string;
  factIds: string[];
  transformation: FactTransformation | null;
}

/** Model-backed Application Drafter (spec §9); proposals only, validated by deterministic code. */
export interface ApplicationDrafter {
  readonly name: string;
  draftCoverLetter(
    input: {
      job: { id: string; title: string; company: string; descriptionText: string };
      requirements: { key: string; text: string; kind: string }[];
      facts: GeneratorFact[];
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{ paragraphs: DraftSegment[][]; runs: ProviderRunRecord[]; promptId: string }>;
  draftAnswers(
    input: {
      job: { id: string; title: string; company: string; descriptionText: string };
      questions: { fieldId: string; label: string }[];
      facts: GeneratorFact[];
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{
    answers: { fieldId: string; segments: DraftSegment[] }[];
    runs: ProviderRunRecord[];
    promptId: string;
  }>;
  reviseSegment(
    input: {
      segment: DraftSegment;
      problems: string[];
      facts: GeneratorFact[];
      postingExcerpt: string;
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{ revised: DraftSegment | null; runs: ProviderRunRecord[]; promptId: string }>;
}

export interface RenderedLetter {
  html: string;
  pdf: Buffer;
  docx: Buffer;
  text: string;
  pageCount: number;
  checks: RenderCheck[];
}

export interface CoverLetterRenderer {
  render(letter: CoverLetter): Promise<RenderedLetter>;
}
