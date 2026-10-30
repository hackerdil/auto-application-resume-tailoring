import { InvalidTransitionError } from "../errors.js";
import type { JobStatus } from "../schemas/job.js";

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  DISCOVERED: ["NORMALIZED"],
  NORMALIZED: ["FILTERED", "ELIGIBLE"],
  FILTERED: ["ARCHIVED"],
  ELIGIBLE: ["SCORED"],
  SCORED: ["SHORTLISTED", "SKIPPED", "SCORED"],
  SHORTLISTED: ["ARCHIVED"],
  SKIPPED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!JOB_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError("job", from, to);
}
