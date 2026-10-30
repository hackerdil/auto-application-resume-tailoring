import { InvalidTransitionError } from "../errors.js";
import type { Actor } from "../schemas/common.js";
import type { ApplicationState } from "../schemas/application.js";
import type { OperatingMode } from "../schemas/run.js";

export const APPLICATION_TRANSITIONS: Readonly<
  Record<ApplicationState, readonly ApplicationState[]>
> = {
  DRAFT: ["TAILORING", "WITHDRAWN"],
  TAILORING: ["VERIFYING", "FAILED", "WITHDRAWN"],
  VERIFYING: ["READY_TO_PREPARE", "TAILORING", "FAILED", "WITHDRAWN"],
  READY_TO_PREPARE: ["PREPARING", "WITHDRAWN"],
  PREPARING: ["AWAITING_USER_INPUT", "READY_FOR_REVIEW", "FAILED", "WITHDRAWN"],
  AWAITING_USER_INPUT: ["PREPARING", "WITHDRAWN"],
  READY_FOR_REVIEW: ["APPROVED_TO_SUBMIT", "PREPARING", "WITHDRAWN"],
  APPROVED_TO_SUBMIT: ["SUBMITTING", "READY_FOR_REVIEW", "WITHDRAWN"],
  // No WITHDRAWN from SUBMITTING: the click may already have happened.
  SUBMITTING: ["SUBMITTED", "SUBMISSION_UNCERTAIN", "FAILED"],
  SUBMISSION_UNCERTAIN: ["SUBMITTED", "FAILED"],
  SUBMITTED: [],
  FAILED: [],
  WITHDRAWN: [],
};

export const TERMINAL_APPLICATION_STATES: ReadonlySet<ApplicationState> = new Set([
  "SUBMITTED",
  "FAILED",
  "WITHDRAWN",
]);

/**
 * Facts the guards need. Callers compute these from persisted state — never from model output.
 * Fields are optional so a caller only supplies what the specific transition requires; a missing
 * fact is treated as "not satisfied" (fail closed).
 */
export interface ApplicationTransitionContext {
  actor: Actor;
  mode: OperatingMode;
  artifactsVerified?: boolean;
  answerSetComplete?: boolean;
  activeApprovalId?: string | null;
  confirmationEvidence?: string | null;
}

type Guard = (ctx: ApplicationTransitionContext) => string | null;

const GUARDS: Partial<Record<`${ApplicationState}->${ApplicationState}`, Guard>> = {
  "VERIFYING->READY_TO_PREPARE": (c) =>
    c.artifactsVerified === true ? null : "only verified artifacts can enter READY_TO_PREPARE",
  "READY_TO_PREPARE->PREPARING": (c) =>
    c.mode === "research-only" ? "research-only mode cannot prepare applications" : null,
  "PREPARING->READY_FOR_REVIEW": (c) =>
    c.answerSetComplete === true ? null : "only a complete answer set can enter READY_FOR_REVIEW",
  "READY_FOR_REVIEW->APPROVED_TO_SUBMIT": (c) => {
    if (c.mode !== "review-each")
      return `approvals are only possible in review-each mode (mode: ${c.mode})`;
    if (c.actor !== "user") return "only the user can approve an application";
    return c.activeApprovalId ? null : "an active approval token is required";
  },
  "APPROVED_TO_SUBMIT->SUBMITTING": (c) => {
    if (c.actor !== "system")
      return "only the deterministic submission service may start submitting";
    return c.activeApprovalId ? null : "an active approval token is required";
  },
  "SUBMITTING->SUBMITTED": (c) =>
    c.confirmationEvidence ? null : "SUBMITTED requires observed confirmation evidence",
  "SUBMISSION_UNCERTAIN->SUBMITTED": (c) =>
    c.actor === "user" ? null : "uncertain submissions can only be resolved by the user",
  "SUBMISSION_UNCERTAIN->FAILED": (c) =>
    c.actor === "user" ? null : "uncertain submissions can only be resolved by the user",
};

const MODEL_ACTORS: ReadonlySet<Actor> = new Set(["openai", "claude"]);

/** Throws InvalidTransitionError when the edge does not exist or its guard fails. */
export function assertApplicationTransition(
  from: ApplicationState,
  to: ApplicationState,
  ctx: ApplicationTransitionContext,
): void {
  if (!APPLICATION_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError("application", from, to);
  }
  // Models propose; they never move an application past review.
  if (
    MODEL_ACTORS.has(ctx.actor) &&
    ["APPROVED_TO_SUBMIT", "SUBMITTING", "SUBMITTED", "FAILED", "WITHDRAWN"].includes(to)
  ) {
    throw new InvalidTransitionError(
      "application",
      from,
      to,
      `actor ${ctx.actor} may not perform this transition`,
    );
  }
  const reason = GUARDS[`${from}->${to}`]?.(ctx) ?? null;
  if (reason) throw new InvalidTransitionError("application", from, to, reason);
}
