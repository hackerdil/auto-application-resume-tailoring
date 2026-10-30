import { z } from "zod";
import type { PromptMessage } from "../types.js";

/**
 * Purpose: independent, adversarial check that each résumé claim is supported by its cited facts (spec §9
 * Integrity Reviewer). Inputs: claims with their facts (trusted). Output: IntegrityReviewOutput.
 * The reviewer cannot change anything; a "not supported" verdict triggers one revision, then removal.
 */
export const INTEGRITY_REVIEW_PROMPT = { id: "integrity-review", version: "1" } as const;

export const IntegrityReviewOutput = z.object({
  verdicts: z
    .array(
      z.object({
        itemKey: z.string(),
        supported: z.boolean(),
        problems: z.array(z.string().max(300)).max(10),
      }),
    )
    .max(80),
});

const SYSTEM = `You are an independent integrity reviewer for a résumé. Be strict.
For each claim, decide whether every part of it is supported by the facts listed under it.
Flag: numbers, dates, employers, titles, tools, credentials, scope, team size, seniority, leadership, and cause-and-effect statements that the facts do not state; exaggeration; misleading proficiency.
Return one verdict per itemKey. Output JSON only.`;

export function renderIntegrityReview(
  items: { itemKey: string; text: string; facts: { id: string; claim: string }[] }[],
): PromptMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: items
        .map(
          (i) =>
            `${i.itemKey}: ${i.text}\n${i.facts.map((f) => `  fact ${f.id}: ${f.claim}`).join("\n")}`,
        )
        .join("\n\n"),
    },
  ];
}
