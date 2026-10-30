import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../errors.js";
import { ApplicationState } from "../schemas/application.js";
import {
  APPLICATION_TRANSITIONS,
  assertApplicationTransition,
  type ApplicationTransitionContext,
} from "./application.js";

const permissive: ApplicationTransitionContext = {
  actor: "system",
  mode: "review-each",
  artifactsVerified: true,
  answerSetComplete: true,
  activeApprovalId: "approval",
  confirmationEvidence: "confirmation page",
};

const states = ApplicationState.options;

describe("application state machine", () => {
  it("rejects every edge not in the transition table", () => {
    for (const from of states) {
      for (const to of states) {
        if (APPLICATION_TRANSITIONS[from].includes(to)) continue;
        expect(() => {
          assertApplicationTransition(from, to, permissive);
        }, `${from}->${to}`).toThrow(InvalidTransitionError);
      }
    }
  });

  it("terminal states have no outgoing edges", () => {
    for (const s of ["SUBMITTED", "FAILED", "WITHDRAWN"] as const)
      expect(APPLICATION_TRANSITIONS[s]).toEqual([]);
  });

  it("cannot be submitted twice", () => {
    expect(() => {
      assertApplicationTransition("SUBMITTED", "SUBMITTING", permissive);
    }).toThrow();
  });

  it("only verified artifacts reach READY_TO_PREPARE", () => {
    expect(() => {
      assertApplicationTransition("VERIFYING", "READY_TO_PREPARE", {
        ...permissive,
        artifactsVerified: false,
      });
    }).toThrow(/verified artifacts/);
    expect(() => {
      assertApplicationTransition("VERIFYING", "READY_TO_PREPARE", {
        actor: "system",
        mode: "review-each",
      });
    }).toThrow(/verified artifacts/);
    assertApplicationTransition("VERIFYING", "READY_TO_PREPARE", permissive);
  });

  it("research-only mode cannot prepare", () => {
    expect(() => {
      assertApplicationTransition("READY_TO_PREPARE", "PREPARING", {
        ...permissive,
        mode: "research-only",
      });
    }).toThrow(/research-only/);
  });

  it("only a complete answer set reaches READY_FOR_REVIEW", () => {
    expect(() => {
      assertApplicationTransition("PREPARING", "READY_FOR_REVIEW", {
        ...permissive,
        answerSetComplete: false,
      });
    }).toThrow(/complete answer set/);
  });

  describe("approval", () => {
    const ok = { ...permissive, actor: "user" as const };
    it("requires the user, review-each mode, and an active token", () => {
      assertApplicationTransition("READY_FOR_REVIEW", "APPROVED_TO_SUBMIT", ok);
      for (const mode of ["prepare", "dry-run", "research-only"] as const) {
        expect(() => {
          assertApplicationTransition("READY_FOR_REVIEW", "APPROVED_TO_SUBMIT", { ...ok, mode });
        }).toThrow(/review-each/);
      }
      expect(() => {
        assertApplicationTransition("READY_FOR_REVIEW", "APPROVED_TO_SUBMIT", {
          ...ok,
          activeApprovalId: null,
        });
      }).toThrow(/approval token/);
      expect(() => {
        assertApplicationTransition("READY_FOR_REVIEW", "APPROVED_TO_SUBMIT", {
          ...ok,
          actor: "system",
        });
      }).toThrow(/only the user/);
    });

    it.each(["openai", "claude"] as const)(
      "model actor %s can never approve or submit",
      (actor) => {
        expect(() => {
          assertApplicationTransition("READY_FOR_REVIEW", "APPROVED_TO_SUBMIT", { ...ok, actor });
        }).toThrow();
        expect(() => {
          assertApplicationTransition("APPROVED_TO_SUBMIT", "SUBMITTING", { ...permissive, actor });
        }).toThrow();
        expect(() => {
          assertApplicationTransition("SUBMITTING", "SUBMITTED", { ...permissive, actor });
        }).toThrow();
      },
    );

    it("only the deterministic system actor starts submitting", () => {
      assertApplicationTransition("APPROVED_TO_SUBMIT", "SUBMITTING", permissive);
      expect(() => {
        assertApplicationTransition("APPROVED_TO_SUBMIT", "SUBMITTING", {
          ...permissive,
          actor: "user",
        });
      }).toThrow();
      expect(() => {
        assertApplicationTransition("APPROVED_TO_SUBMIT", "SUBMITTING", {
          ...permissive,
          actor: "browser",
        });
      }).toThrow();
    });
  });

  it("SUBMITTED requires confirmation evidence", () => {
    expect(() => {
      assertApplicationTransition("SUBMITTING", "SUBMITTED", {
        ...permissive,
        confirmationEvidence: null,
      });
    }).toThrow(/confirmation evidence/);
    assertApplicationTransition("SUBMITTING", "SUBMISSION_UNCERTAIN", {
      ...permissive,
      confirmationEvidence: null,
    });
  });

  it("uncertain submissions are resolved only by the user", () => {
    expect(() => {
      assertApplicationTransition("SUBMISSION_UNCERTAIN", "SUBMITTED", permissive);
    }).toThrow(/user/);
    expect(() => {
      assertApplicationTransition("SUBMISSION_UNCERTAIN", "FAILED", permissive);
    }).toThrow(/user/);
    assertApplicationTransition("SUBMISSION_UNCERTAIN", "FAILED", { ...permissive, actor: "user" });
  });

  it("cannot be withdrawn while submitting", () => {
    expect(() => {
      assertApplicationTransition("SUBMITTING", "WITHDRAWN", { ...permissive, actor: "user" });
    }).toThrow();
  });
});
