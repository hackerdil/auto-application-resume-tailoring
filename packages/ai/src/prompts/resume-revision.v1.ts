import { z } from "zod";
import type { PromptMessage } from "../types.js";

/**
 * Purpose: one attempt to fix a résumé claim that failed verification. Inputs: the claim, its cited facts, and
 * the problems found (all trusted). Output: RevisionOutput; `revised: null` when the facts cannot support it.
 */
export const RESUME_REVISION_PROMPT = { id: "resume-revision", version: "1" } as const;

export const RevisionOutput = z.object({
  revised: z
    .object({
      text: z.string().min(1).max(400),
      sourceFactIds: z.array(z.string()).min(1).max(4),
      transformation: z.enum(["select", "reorder", "shorten", "rephrase", "combine"]),
    })
    .nullable(),
});

const SYSTEM = `You fix one résumé claim so that it is fully supported by its cited facts.
- Remove anything the problems list mentions. Do not add new information.
- If the facts cannot support a useful claim, return {"revised": null}.
- Use only the given fact ids and only transformations each fact allows.
- Output JSON only.`;

export function renderResumeRevision(input: {
  text: string;
  transformation: string;
  problems: string[];
  facts: { id: string; claim: string; allowedTransformations: string[] }[];
}): PromptMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `CLAIM (${input.transformation}): ${input.text}\n\nPROBLEMS:\n${input.problems.map((p) => `- ${p}`).join("\n")}\n\nFACTS:\n${input.facts.map((f) => `- ${f.id} [${f.allowedTransformations.join("/")}] ${f.claim}`).join("\n")}`,
    },
  ];
}
