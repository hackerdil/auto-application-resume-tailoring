/**
 * Error taxonomy. Every error carries a stable `code` and a user-safe message.
 * Raw causes stay on `cause` and must never be serialized to the UI (see `toSafeError`).
 */
export abstract class CareerAgentError extends Error {
  abstract readonly code: string;
  /** Whether automatic retry is ever allowed for this class. Default: no. */
  readonly retryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends CareerAgentError {
  readonly code = "VALIDATION";
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

export class NotFoundError extends CareerAgentError {
  readonly code = "NOT_FOUND";
}

export class ConflictError extends CareerAgentError {
  readonly code = "CONFLICT";
}

export class InvalidTransitionError extends CareerAgentError {
  readonly code = "INVALID_TRANSITION";
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
    reason?: string,
  ) {
    super(`${machine}: transition ${from} → ${to} is not allowed${reason ? `: ${reason}` : ""}`);
  }
}

export class PolicyError extends CareerAgentError {
  readonly code = "POLICY";
}

export class ApprovalError extends CareerAgentError {
  readonly code = "APPROVAL";
  constructor(
    readonly reason:
      | "missing"
      | "invalid"
      | "expired"
      | "revoked"
      | "consumed"
      | "binding_mismatch"
      | "wrong_application",
    message?: string,
  ) {
    super(message ?? `Approval rejected: ${reason}`);
  }
}

export class AmbiguousSubmissionError extends CareerAgentError {
  readonly code = "AMBIGUOUS_SUBMISSION";
}

export class BudgetExceededError extends CareerAgentError {
  readonly code = "BUDGET_EXCEEDED";
  constructor(
    readonly limit: string,
    message?: string,
  ) {
    super(message ?? `Run limit exceeded: ${limit}`);
  }
}

// ---- Provider errors (spec §8). Raw SDK errors are mapped into these. ----

export type ProviderName = "openai" | "claude";

export abstract class ProviderError extends CareerAgentError {
  constructor(
    readonly provider: ProviderName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class ProviderUnavailableError extends ProviderError {
  readonly code = "PROVIDER_UNAVAILABLE";
  override readonly retryable = true;
}
export class ProviderAuthenticationError extends ProviderError {
  readonly code = "PROVIDER_AUTHENTICATION";
}
export class ProviderRateLimitError extends ProviderError {
  readonly code = "PROVIDER_RATE_LIMIT";
  override readonly retryable = true;
}
export class ProviderQuotaExceededError extends ProviderError {
  readonly code = "PROVIDER_QUOTA_EXCEEDED";
}
export class ProviderTimeoutError extends ProviderError {
  readonly code = "PROVIDER_TIMEOUT";
  override readonly retryable = true;
}
export class ProviderPolicyError extends ProviderError {
  readonly code = "PROVIDER_POLICY";
}
export class ProviderInvalidOutputError extends ProviderError {
  readonly code = "PROVIDER_INVALID_OUTPUT";
}
export class ProviderExecutionError extends ProviderError {
  readonly code = "PROVIDER_EXECUTION";
}

export interface SafeError {
  code: string;
  message: string;
}

/** Shape safe to return from the API: no stack, no cause, no raw provider text for unknown errors. */
export function toSafeError(err: unknown): SafeError {
  if (err instanceof CareerAgentError) return { code: err.code, message: err.message };
  return { code: "INTERNAL", message: "An internal error occurred." };
}
