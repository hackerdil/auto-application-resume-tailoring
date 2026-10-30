import type { ProviderName, RunLimits } from "@career-agent/domain";

export type TaskType =
  | "resume_extraction"
  | "requirement_extraction"
  | "match_scoring"
  | "resume_tailoring"
  | "integrity_review"
  | "application_drafting"
  | "form_preparation";

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

export interface ProviderRequest {
  taskType: TaskType;
  promptId: string;
  promptVersion: string;
  messages: PromptMessage[];
  /** JSON schema of the expected structured output (derived from the Zod schema). */
  outputJsonSchema: Record<string, unknown>;
  limits: RunLimits;
  signal: AbortSignal;
  traceId: string;
  idempotencyKey?: string;
}

export interface ProviderUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderRunMeta {
  provider: ProviderName;
  model: string | null;
  traceId: string;
  requestId: string | null;
  durationMs: number;
  usage: ProviderUsage;
  costUsd: number | null;
  toolCalls: number;
  delegated: boolean;
  fallback: boolean;
}

export interface ProviderResult {
  /** Unvalidated structured output. Callers validate with `runStructured`. */
  output: unknown;
  meta: ProviderRunMeta;
}

export type ProviderHealth = { ok: true } | { ok: false; reason: string };

/** Spec §8 provider-neutral interface. */
export interface AIProvider {
  readonly name: ProviderName;
  health(): Promise<ProviderHealth>;
  run(request: ProviderRequest): Promise<ProviderResult>;
}
