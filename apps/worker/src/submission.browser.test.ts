import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApprovalError } from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import {
  ApprovalService,
  approvalKey,
  buildBindingMaterial,
  sealApprovalSecret,
} from "@career-agent/security";
import { startFormFixtureServer, type FormFixtureServer } from "@career-agent/testkit";
import { setup } from "./browser-test-setup.js";
import { BrowserPreparer } from "./preparer.js";
import { Submitter } from "./submitter.js";

let server: FormFixtureServer;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  server = await startFormFixtureServer();
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  server.writes.length = 0;
  server.mode = "confirm";
});
afterAll(async () => {
  await server.close();
});

const TTL = 300;

/** A Greenhouse-like application prepared, consent ticked by the "owner", and reviewed: ready to approve. */
async function reviewed() {
  const s = setup(null, `${server.origin.replace("127.0.0.1", "ats.localhost")}/greenhouse`);
  const sessionSecret = randomBytes(32);
  const clock = { now: Date.now() };
  const approvals = new ApprovalService({
    approvals: s.store.approvals,
    applications: s.store.applications,
    attempts: s.store.submissionAttempts,
    audit: s.store.audit,
    uow: (fn) => s.store.transaction(fn),
    key: approvalKey(sessionSecret),
    ttlSeconds: TTL,
    mode: "review-each",
    now: () => new Date(clock.now),
  });
  const logger = createLogger({ level: "silent" });
  const preparer = new BrowserPreparer({
    store: s.store,
    applications: s.service,
    files: s.files,
    ownerId: s.ownerId,
    logger,
    headless: true,
    maxSteps: 80,
    sessionTimeoutMs: 120_000,
    allowPrivateNetwork: true,
  });
  cleanup.push(() => preparer.closeAll());
  const submitter = new Submitter({
    store: s.store,
    applications: s.service,
    approvals,
    preparer,
    files: s.files,
    ownerId: s.ownerId,
    sessionSecret,
    mode: "review-each",
    logger,
    outcomeTimeoutMs: 4_000,
  });
  const app = s.service.create(s.ownerId, s.job.id, "t");
  const resume = await s.tailoring.tailor(s.job.id, s.ownerId, "one-page", "t");
  s.tailoring.decide(resume.resume.id, "approved", "t");
  s.service.selectResume(s.ownerId, app.id, resume.resume.id, "t");
  s.service.skipCoverLetter(s.ownerId, app.id, true, "t");
  await preparer.prepare(app.id, "t");
  let o = s.service.overview(s.ownerId, app.id);
  for (const [category, value] of [
    ["work_authorization", "Yes"],
    ["sponsorship", "No"],
  ] as const) {
    const a = o.answers.find((x) => x.field.category === category && x.field.origin === "page");
    if (!a) throw new Error(`expected ${category}`);
    o = s.service.answer(s.ownerId, app.id, a.field.id, { value }, "t");
  }
  expect((await preparer.prepare(app.id, "t")).status).toBe("ready");
  const live = preparer.liveFor(app.id);
  if (!live) throw new Error("expected a live window");
  // Not approvable until the owner ticks the consent box themselves.
  expect((await preparer.review(app.id)).checklist.join(" ")).toMatch(/privacy policy/);
  await live.session.page.check("#privacy");
  const review = await preparer.review(app.id);
  expect(review.checklist).toEqual([]);

  /** Mirrors POST /applications/:id/approve. */
  const approve = (over: { origin?: string } = {}) => {
    const m = s.service.submissionMaterials(s.ownerId, app.id, () => undefined);
    if (!review.submitControl) throw new Error("expected a submit control");
    const { approvalId, secret } = approvals.issue(
      s.ownerId,
      buildBindingMaterial({
        applicationId: app.id,
        ownerId: s.ownerId,
        job: m.job,
        answers: m.answers,
        resumeHash: m.resumeHash,
        coverLetterHash: m.coverLetterHash,
        formSnapshotHash: review.formSnapshotHash,
        origin: over.origin ?? review.origin,
        submitControl: review.submitControl,
      }),
      "t",
    );
    return { approvalId, sealed: sealApprovalSecret(sessionSecret, approvalId, secret) };
  };
  const submit = (a: { approvalId: string; sealed: string }) =>
    submitter.submit(app.id, a.approvalId, a.sealed, "t");
  const state = () => s.service.overview(s.ownerId, app.id).application.state;
  return { s, app, approvals, preparer, live, approve, submit, state, clock, sessionSecret, o };
}

const rejects = async (p: Promise<unknown>, reason: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApprovalError);
  expect((err as ApprovalError).reason).toBe(reason);
};

describe("approval and submission (APPROVAL_MODEL §5)", () => {
  it("submits once on a matching approval, records evidence, and refuses a replay", async () => {
    const r = await reviewed();
    const a = r.approve();
    expect(r.state()).toBe("APPROVED_TO_SUBMIT");
    const out = await r.submit(a);
    expect(out.outcome).toBe("submitted");
    expect(out.evidence.headings.join(" ")).toMatch(/Thank you/);
    expect(r.state()).toBe("SUBMITTED");
    expect(server.writes).toHaveLength(1);
    // Replay of the same approval: refused, nothing sent again.
    await rejects(r.submit(a), "consumed");
    expect(server.writes).toHaveLength(1);
    expect(r.s.store.submissionAttempts.latest(r.app.id)).toMatchObject({ outcome: "submitted" });
    const audit = JSON.stringify(
      r.s.store.sqlite
        .prepare("SELECT metadata FROM audit_events WHERE new_state = 'SUBMITTED'")
        .all(),
    );
    expect(audit).not.toMatch(/alex\.example|Alex Example/);
  });

  it("refuses an unknown approval and a wrong token", async () => {
    const r = await reviewed();
    const a = r.approve();
    r.approvals.revoke(r.app.id, "cancelled by owner", "t");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    const other = r.approve();
    await rejects(r.submit(a), "revoked");
    const forged = {
      approvalId: other.approvalId,
      sealed: sealApprovalSecret(r.sessionSecret, other.approvalId, "not-the-secret"),
    };
    await rejects(r.submit(forged), "invalid");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    await rejects(
      r.submit({ approvalId: "0190f0b0-0000-7000-8000-000000000000", sealed: forged.sealed }),
      "invalid",
    );
    expect(server.writes).toEqual([]);
  });

  it("refuses an expired approval", async () => {
    const r = await reviewed();
    const a = r.approve();
    r.clock.now += (TTL + 1) * 1000;
    await rejects(r.submit(a), "expired");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    expect(server.writes).toEqual([]);
  });

  it("refuses when the form changed after approval", async () => {
    const r = await reviewed();
    const a = r.approve();
    await r.live.session.page.fill("#phone", "+1 555 0199");
    await rejects(r.submit(a), "binding_mismatch");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    expect(r.s.store.approvals.get(a.approvalId)?.revokeReason).toMatch(/formSnapshotHash/);
    expect(server.writes).toEqual([]);
  });

  it("cancels the approval when the owner edits an answer", async () => {
    const r = await reviewed();
    const a = r.approve();
    const auth = r.o.answers.find((x) => x.field.category === "work_authorization");
    if (!auth) throw new Error("expected question");
    r.s.service.answer(r.s.ownerId, r.app.id, auth.field.id, { value: "No" }, "t");
    expect(r.state()).toBe("PREPARING");
    await rejects(r.submit(a), "revoked");
    expect(server.writes).toEqual([]);
  });

  it("refuses when an approved file changed on disk", async () => {
    const r = await reviewed();
    const a = r.approve();
    const ref = r.s.service.approvedFileRef(r.s.ownerId, r.app.id, "resume");
    const art = ref ? r.s.store.artifacts.get(ref.artifactId) : null;
    if (!art) throw new Error("expected artifact");
    writeFileSync(path.join(r.s.artifactDir, art.storagePath), "%PDF-tampered");
    await rejects(r.submit(a), "binding_mismatch");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    expect(server.writes).toEqual([]);
  });

  it("refuses an approval bound to another origin", async () => {
    const r = await reviewed();
    const a = r.approve({ origin: "https://boards.greenhouse.io" });
    await rejects(r.submit(a), "binding_mismatch");
    expect(server.writes).toEqual([]);
  });

  it("lets only one of two concurrent submits click", async () => {
    const r = await reviewed();
    const a = r.approve();
    const results = await Promise.allSettled([r.submit(a), r.submit(a)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(failed?.reason).toBeInstanceOf(ApprovalError);
    expect(server.writes).toHaveLength(1);
  });

  it("marks an ambiguous network failure uncertain and never retries", async () => {
    const r = await reviewed();
    server.mode = "drop";
    const out = await r.submit(r.approve());
    expect(out.outcome).toBe("uncertain");
    expect(r.state()).toBe("SUBMISSION_UNCERTAIN");
    expect(server.writes).toHaveLength(1);
  });

  it("returns to review when the site rejects the form before sending anything", async () => {
    const r = await reviewed();
    const a = r.approve();
    await r.live.session.page.evaluate("window.__fixtureReject = true");
    const out = await r.submit(a);
    expect(out.outcome).toBe("rejected_before_send");
    expect(out.evidence.errors.join(" ")).toMatch(/check your email/);
    expect(r.state()).toBe("READY_FOR_REVIEW");
    expect(server.writes).toEqual([]);
  });

  it("revokes approvals when the browser is gone", async () => {
    const r = await reviewed();
    const a = r.approve();
    await r.preparer.close(r.app.id);
    await rejects(r.submit(a), "binding_mismatch");
    expect(r.state()).toBe("READY_FOR_REVIEW");
    expect(r.s.store.approvals.get(a.approvalId)?.revokeReason).toBe("browser closed");
    expect(server.writes).toEqual([]);
  });
});
