import { z } from "zod";

/** Spec §4.5: every agent run is bounded. */
export const RunLimits = z.object({
  deadlineMs: z.number().int().positive(),
  maxModelTurns: z.number().int().positive(),
  maxToolCalls: z.number().int().nonnegative(),
  maxBrowserSteps: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative().max(5),
  maxInputChars: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().nullable(),
});
export type RunLimits = z.infer<typeof RunLimits>;

export const OperatingMode = z.enum(["research-only", "prepare", "review-each", "dry-run"]);
export type OperatingMode = z.infer<typeof OperatingMode>;
