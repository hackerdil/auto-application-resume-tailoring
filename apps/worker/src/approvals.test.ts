import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApprovalError,
  uuidv7,
  type BindingMaterial,
  type OperatingMode,
} from "@career-agent/domain";
import {
  answerSetHash,
  ApprovalService,
  approvalKey,
  openApprovalSecret,
  sealApprovalSecret,
} from "@career-agent/security";
import { setup } from "./browser-test-setup.js";

const H = (c: string) => c.repeat(64);

function harness(mode: OperatingMode = "review-each") {
  const s = setup();
  const app = s.service.create(s.ownerId, s.job.id, "t");
  // Tests start from review directly; the browser path is covered by submission.browser.test.ts.
  s.store.sqlite
    .prepare("UPDATE applications SET state = 'READY_FOR_REVIEW' WHERE id = ?")
    .run(app.id);
  const clock = { now: Date.parse("2026-10-30T12:00:00Z") };
  const key = approvalKey(randomBytes(32));
  const make = (k = key, m = mode) =>
    new ApprovalService({
      approvals: s.store.approvals,
      applications: s.store.applications,
      attempts: s.store.submissionAttempts,
      audit: s.store.audit,
      uow: (fn) => s.store.transaction(fn),
      key: k,
      ttlSeconds: 300,
      mode: m,
      now: () => new Date(clock.now),
    });
  const material: BindingMaterial = {
    applicationId: app.id,
    ownerId: s.ownerId,
    jobUrl: "https://boards.greenhouse.io/initech/jobs/7",
    origin: "https://boards.greenhouse.io",
    jobId: s.job.id,
    formSnapshotHash: H("a"),
    answerSetHash: H("b"),
    resumeArtifactHash: H("c"),
    coverLetterArtifactHash: null,
    submitControl: {
      adapter: "greenhouse",
      selectorFingerprint: "f",
      accessibleName: "Submit Application",
      frameUrl: "main",
    },
  };
  const state = () => s.store.applications.get(app.id)?.state;
  return { s, app, clock, service: make(), make, material, state };
}

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApprovalError) return e.reason;
    throw e;
  }
  return "none";
};

describe("ApprovalService", () => {
  it("issues a single-use token bound to the material and verifies it", () => {
    const h = harness();
    const { approvalId, secret, binding } = h.service.issue(h.s.ownerId, h.material, "t");
    expect(h.state()).toBe("APPROVED_TO_SUBMIT");
    expect(binding.expiresAt).toBe("2026-10-30T12:05:00.000Z");
    const rec = h.s.store.approvals.get(approvalId);
    expect(rec?.tokenHash).not.toContain(secret);
    expect(JSON.stringify(rec)).not.toContain(secret);
    expect(h.service.verify(approvalId, secret, h.app.id).formSnapshotHash).toBe(H("a"));
  });

  it("rejects missing, wrong token, wrong application, tampered, and expired approvals", () => {
    const h = harness();
    const { approvalId, secret } = h.service.issue(h.s.ownerId, h.material, "t");
    expect(reason(() => h.service.verify(uuidv7(), secret, h.app.id))).toBe("missing");
    expect(reason(() => h.service.verify(approvalId, "nope", h.app.id))).toBe("invalid");
    expect(reason(() => h.service.verify(approvalId, secret, uuidv7()))).toBe("wrong_application");
    // A MAC made with another key (or an edited binding) is refused.
    expect(
      reason(() => h.make(approvalKey(randomBytes(32))).verify(approvalId, secret, h.app.id)),
    ).toBe("invalid");
    h.clock.now += 301_000;
    expect(reason(() => h.service.verify(approvalId, secret, h.app.id))).toBe("expired");
  });

  it("refuses the wrong owner and modes without approvals", () => {
    const h = harness();
    expect(reason(() => h.service.issue(uuidv7(), h.material, "t"))).toBe("wrong_application");
    expect(() => h.make(undefined, "dry-run").issue(h.s.ownerId, h.material, "t")).toThrow(
      /does not allow/,
    );
    expect(() => h.make(undefined, "prepare").issue(h.s.ownerId, h.material, "t")).toThrow(
      /does not allow/,
    );
    expect(h.state()).toBe("READY_FOR_REVIEW");
  });

  it("consumes exactly once and starts one attempt", () => {
    const h = harness();
    const { approvalId } = h.service.issue(h.s.ownerId, h.material, "t");
    const attempt = h.service.consumeAndStart(approvalId, h.app.id, "t");
    expect(h.state()).toBe("SUBMITTING");
    expect(attempt.approvalId).toBe(approvalId);
    expect(reason(() => h.service.consumeAndStart(approvalId, h.app.id, "t"))).toBe("consumed");
    expect(h.state()).toBe("SUBMITTING");
    // Consumed approvals are immutable and cannot be revoked or reused.
    expect(h.s.store.approvals.revoke(approvalId, "x")).toBe(false);
    expect(() =>
      h.s.store.sqlite
        .prepare("UPDATE application_approvals SET consumed_at = NULL WHERE id = ?")
        .run(approvalId),
    ).toThrow(/single-use/);
    expect(() => h.s.store.submissionAttempts.start(h.app.id, approvalId)).toThrow(/UNIQUE/);
  });

  it("does not consume revoked or expired approvals, and revocation returns to review", () => {
    const h = harness();
    const first = h.service.issue(h.s.ownerId, h.material, "t");
    expect(h.service.revoke(h.app.id, "cancelled by owner", "t")).toBe(true);
    expect(h.state()).toBe("READY_FOR_REVIEW");
    expect(reason(() => h.service.consumeAndStart(first.approvalId, h.app.id, "t"))).toBe(
      "consumed",
    );
    const second = h.service.issue(h.s.ownerId, h.material, "t");
    h.clock.now += 301_000;
    expect(reason(() => h.service.consumeAndStart(second.approvalId, h.app.id, "t"))).toBe(
      "consumed",
    );
    expect(h.state()).toBe("APPROVED_TO_SUBMIT");
    // An attempt can only exist for a consumed approval.
    expect(() => h.s.store.submissionAttempts.start(h.app.id, second.approvalId)).toThrow(
      /consumed approval/,
    );
  });

  it("seals the token for transport, bound to the approval id", () => {
    const secret = randomBytes(32);
    const sealed = sealApprovalSecret(secret, "a1", "token");
    expect(sealed).not.toContain("token");
    expect(openApprovalSecret(secret, "a1", sealed)).toBe("token");
    expect(() => openApprovalSecret(secret, "a2", sealed)).toThrow(ApprovalError);
    expect(() => openApprovalSecret(randomBytes(32), "a1", sealed)).toThrow(ApprovalError);
  });

  it("hashes answer sets independent of order", () => {
    const a = answerSetHash([
      { fieldId: "1", finalValue: "x" },
      { fieldId: "2", finalValue: null },
    ]);
    expect(
      answerSetHash([
        { fieldId: "2", finalValue: null },
        { fieldId: "1", finalValue: "x" },
      ]),
    ).toBe(a);
    expect(
      answerSetHash([
        { fieldId: "1", finalValue: "y" },
        { fieldId: "2", finalValue: null },
      ]),
    ).not.toBe(a);
  });
});
