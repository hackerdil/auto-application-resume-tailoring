import { PolicyError } from "@career-agent/domain";
import { redactString } from "@career-agent/security";
import type { PromptMessage } from "./types.js";

/**
 * Last line of defence before data leaves the machine: abort if a rendered prompt contains anything
 * the redactor recognizes as a secret (docs/PROMPT_SECURITY.md §5).
 */
export function assertNoSecrets(
  messages: readonly PromptMessage[],
  extraValues: readonly string[] = [],
): void {
  for (const m of messages) {
    if (redactString(m.content, { extraValues }) !== m.content) {
      throw new PolicyError("Refusing to send a prompt that appears to contain a secret.");
    }
  }
}
