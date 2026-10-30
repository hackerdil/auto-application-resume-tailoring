import type { ProviderRunRecord } from "../repositories.js";
import type { RunBudget } from "../run-budget.js";
import type { FactTransformation } from "../schemas/fact.js";
import type { TailoredResume } from "../schemas/resume.js";

export interface GeneratorFact {
  id: string;
  claim: string;
  allowedTransformations: FactTransformation[];
}

export interface GeneratedBullet {
  entryKey: string;
  text: string;
  sourceFactIds: string[];
  targetRequirementKeys: string[];
  transformation: FactTransformation;
}

/** Model-backed résumé writer (implemented in @career-agent/ai). It proposes; the validator decides. */
export interface ResumeGenerator {
  readonly name: string;
  generate(
    input: {
      job: { id: string; title: string; company: string; descriptionText: string };
      requirements: { key: string; text: string; kind: string }[];
      entries: { entryKey: string; heading: string; facts: GeneratorFact[] }[];
      summaryFacts: GeneratorFact[];
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{
    summary: { text: string; sourceFactIds: string[] } | null;
    bullets: GeneratedBullet[];
    runs: ProviderRunRecord[];
    promptId: string;
  }>;
  /** One revision attempt for a claim that failed verification. Returning null means "cannot be fixed". */
  revise(
    input: {
      text: string;
      sourceFactIds: string[];
      transformation: FactTransformation;
      problems: string[];
      facts: GeneratorFact[];
    },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{
    revised: { text: string; sourceFactIds: string[]; transformation: FactTransformation } | null;
    runs: ProviderRunRecord[];
    promptId: string;
  }>;
}

/** Independent adversarial reviewer (Claude in hybrid mode, spec §8). */
export interface IntegrityReviewer {
  readonly name: string;
  review(
    input: { items: { itemKey: string; text: string; facts: { id: string; claim: string }[] }[] },
    ctx: { budget: RunBudget; traceId: string },
  ): Promise<{
    verdicts: { itemKey: string; supported: boolean; problems: string[] }[];
    runs: ProviderRunRecord[];
    promptId: string;
  }>;
}

export interface RenderCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RenderedResume {
  html: string;
  pdf: Buffer;
  docx: Buffer;
  pageCount: number;
  checks: RenderCheck[];
}

/** Renders and verifies a structured résumé (implemented in @career-agent/documents). */
export interface ResumeRenderer {
  render(resume: TailoredResume): Promise<RenderedResume>;
}

export interface ArtifactWriter {
  /** Stores bytes content-addressed and returns the artifact id and hash. */
  write(
    data: Buffer,
    extension: "pdf" | "docx" | "html",
    kind: string,
    mediaType: string,
  ): { id: string; sha256: string };
}
