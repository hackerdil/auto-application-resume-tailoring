import { describe, expect, it } from "vitest";
import { JobStatus } from "../schemas/job.js";
import { assertJobTransition, JOB_TRANSITIONS } from "./job.js";

describe("job state machine", () => {
  it("allows exactly the table's edges", () => {
    for (const from of JobStatus.options) {
      for (const to of JobStatus.options) {
        const allowed = JOB_TRANSITIONS[from].includes(to);
        if (allowed) assertJobTransition(from, to);
        else
          expect(() => {
            assertJobTransition(from, to);
          }, `${from}->${to}`).toThrow();
      }
    }
  });

  it("follows the documented happy path", () => {
    const path = [
      "DISCOVERED",
      "NORMALIZED",
      "ELIGIBLE",
      "SCORED",
      "SHORTLISTED",
      "ARCHIVED",
    ] as const;
    path.slice(1).forEach((to, i) => {
      assertJobTransition(path[i] ?? "DISCOVERED", to);
    });
  });
});
