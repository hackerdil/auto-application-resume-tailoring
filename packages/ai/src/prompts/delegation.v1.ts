import { z } from "zod";
import { wrapUntrusted } from "../untrusted.js";
import type { PromptMessage } from "../types.js";

/**
 * Purpose: delegate_to_claude (spec §8). The orchestrator asks Claude for an independent opinion. Inputs: the
 * question (from the orchestrating model, so untrusted) and context (untrusted). Output: DelegationOutput,
 * returned to the orchestrator as advice. Claude has no tools (ADR-008).
 */
export const DELEGATION_PROMPT = { id: "delegation", version: "1" } as const;

export const DelegationOutput = z.object({
  answer: z.string().max(2000),
  concerns: z.array(z.string().max(300)).max(10),
});
export type DelegationOutput = z.infer<typeof DelegationOutput>;

const SYSTEM = `You give an independent second opinion to another assistant that is preparing a job application.
Answer the question from the supplied context only. Point out anything that looks wrong, unsupported, or risky
(for example a field that seems to ask for consent, a legal declaration, or sensitive personal data).
Never suggest submitting, agreeing, or entering passwords. Output JSON only.`;

export function renderDelegation(question: string, context: string): PromptMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        wrapUntrusted("orchestrator", "question", question),
        wrapUntrusted("orchestrator", "context", context),
      ].join("\n\n"),
    },
  ];
}
