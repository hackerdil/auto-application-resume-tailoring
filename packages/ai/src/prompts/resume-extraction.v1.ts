import { z } from "zod";
import { FactCategory } from "@career-agent/domain";
import { wrapUntrusted } from "../untrusted.js";
import type { PromptMessage } from "../types.js";

/**
 * Purpose: propose candidate career facts from an imported résumé for the owner to verify.
 * Inputs: résumé plain text (untrusted). Output: CandidateFactsOutput.
 * Invariants: every candidate quotes `evidenceText` verbatim from the résumé (checked deterministically
 * afterwards); no inference, no protected characteristics, nothing invented. Candidates are never facts
 * until the owner confirms them.
 */
export const RESUME_EXTRACTION_PROMPT = { id: "resume-extraction", version: "1" } as const;

export const CandidateFactsOutput = z.object({
  candidates: z
    .array(
      z.object({
        category: FactCategory,
        claim: z.string().min(1).max(1000),
        evidenceText: z.string().min(1).max(2000),
      }),
    )
    .max(200),
});
export type CandidateFactsOutput = z.infer<typeof CandidateFactsOutput>;

const SYSTEM = `You extract candidate career facts from a résumé so the résumé's owner can verify them.
Rules:
- Each candidate is one atomic, checkable statement (an employer + title + dates, an achievement, a skill, a degree, a certification, a language, a link).
- "evidenceText" must be copied verbatim from the résumé text. Do not paraphrase it.
- "claim" restates only what the evidence says. Do not add numbers, tools, titles, dates, scope, or outcomes that are not in the evidence.
- Do not infer or record protected or sensitive characteristics (age, gender, ethnicity, religion, health, disability, nationality, marital status), and do not guess work authorization.
- If something is ambiguous, omit it.
- Output JSON only, matching the provided schema.`;

export function renderResumeExtraction(resumeText: string, artifactId: string): PromptMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Extract candidate facts from this résumé.\n\n${wrapUntrusted("resume", artifactId, resumeText)}`,
    },
  ];
}
