import {
  ApprovalError,
  CareerAgentError,
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  PolicyError,
  ValidationError,
  toSafeError,
} from "@career-agent/domain";
import type { z } from "zod";

export class HttpError extends CareerAgentError {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.statusCode;
  if (err instanceof ValidationError) return 400;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError || err instanceof InvalidTransitionError) return 409;
  if (err instanceof PolicyError || err instanceof ApprovalError) return 403;
  return 500;
}

/** Response body for errors: stable code + safe message, plus validation issues when relevant. Never a stack. */
export function errorBody(err: unknown): {
  error: { code: string; message: string; issues?: readonly string[] };
} {
  const safe = toSafeError(err);
  return {
    error: {
      ...safe,
      ...(err instanceof ValidationError && err.issues.length ? { issues: err.issues } : {}),
    },
  };
}

export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      "The request is invalid.",
      r.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`),
    );
  }
  return r.data;
}
