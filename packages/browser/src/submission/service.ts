import {
  ApprovalError,
  bindingDifferences,
  bindingMaterial,
  type ApplicationRepository,
  type AuditRepository,
  type BindingMaterial,
  type OperatingMode,
  type SubmissionAttemptRepository,
  type SubmissionEvidence,
  type SubmissionOutcome,
  type SubmitControlIdentity,
} from "@career-agent/domain";
import type { ApprovalService } from "@career-agent/security";
import type { AtsAdapter } from "../adapters/index.js";
import { classifyControl } from "../controls.js";
import type { BrowserSession } from "../session.js";
import { fingerprint, takeSnapshot, type PageSnapshot, type SnapshotElement } from "../snapshot.js";
import { gateFor } from "./gate.js";

export interface SubmissionDeps {
  approvals: ApprovalService;
  applications: ApplicationRepository;
  attempts: SubmissionAttemptRepository;
  audit: AuditRepository;
  mode: OperatingMode;
  /** How long to wait for the site's response after the click. */
  outcomeTimeoutMs?: number;
}

export interface SubmitRequest {
  approvalId: string;
  secret: string;
  applicationId: string;
  traceId: string;
  session: BrowserSession;
  adapter: AtsAdapter;
  /** Recomputes the binding material from live state: this snapshot, current answers, and files on disk. */
  liveMaterial: (snapshot: PageSnapshot) => BindingMaterial;
}

export interface SubmitResult {
  outcome: SubmissionOutcome;
  evidence: SubmissionEvidence;
}

/** Identity of a submit control as stored in a binding. */
export function submitControlIdentity(
  adapter: AtsAdapter,
  e: SnapshotElement,
): SubmitControlIdentity {
  return {
    adapter: adapter.id,
    selectorFingerprint: fingerprint(e),
    accessibleName: (e.text || e.label || e.value).replace(/\s+/g, " ").trim().slice(0, 120),
    frameUrl: e.frame,
  };
}

const sameControl = (adapter: AtsAdapter, e: SnapshotElement, id: SubmitControlIdentity) => {
  const x = submitControlIdentity(adapter, e);
  return (
    x.adapter === id.adapter &&
    x.selectorFingerprint === id.selectorFingerprint &&
    x.frameUrl === id.frameUrl &&
    x.accessibleName === id.accessibleName
  );
};

/**
 * The only code that can make an external submission (docs/APPROVAL_MODEL.md §4, ADR-007). It verifies the
 * approval, re-snapshots and recomputes the binding, consumes the token atomically, opens the write gate for the
 * bound origin, clicks the bound control exactly once, and classifies what happened. It never retries.
 */
export class SubmissionService {
  constructor(private readonly d: SubmissionDeps) {}

  async submit(r: SubmitRequest): Promise<SubmitResult> {
    // 1. Token, MAC, application, lifetime. Any failure returns an approved application to review.
    let stored;
    try {
      stored = this.d.approvals.verify(r.approvalId, r.secret, r.applicationId);
    } catch (err) {
      if (
        err instanceof ApprovalError &&
        err.reason !== "wrong_application" &&
        err.reason !== "consumed"
      )
        this.d.approvals.revoke(r.applicationId, `approval ${err.reason}`, r.traceId);
      throw err;
    }
    if (r.session.isClosed || r.session.page.isClosed()) {
      this.d.approvals.revoke(r.applicationId, "browser closed", r.traceId);
      throw new ApprovalError("binding_mismatch", "The browser window was closed after approval.");
    }

    // 2. Live state must reproduce the binding exactly.
    const origin = new URL(stored.jobUrl).origin;
    const taken = await takeSnapshot(r.session.page, Date.now(), new Set([origin]));
    let diffs: string[];
    try {
      diffs = bindingDifferences(bindingMaterial(stored), r.liveMaterial(taken.snapshot));
    } catch (err) {
      // Missing or changed files, or answers that can no longer be read: fail closed.
      diffs = [`materials (${err instanceof Error ? err.message.slice(0, 80) : "unreadable"})`];
    }
    const controls = taken.snapshot.elements.filter(
      (e) => classifyControl(e) === "submit" && sameControl(r.adapter, e, stored.submitControl),
    );
    if (controls.length !== 1) diffs.push("submitControl");
    if (diffs.length) {
      this.d.approvals.revoke(r.applicationId, `binding mismatch: ${diffs.join(", ")}`, r.traceId);
      throw new ApprovalError(
        "binding_mismatch",
        `Something changed after you approved (${diffs.join(", ")}). Review the application again.`,
      );
    }
    const control = controls[0] as SnapshotElement;
    const handle = taken.handles.get(control.handle)?.handle;
    if (!handle)
      throw new ApprovalError("binding_mismatch", "The submit button is no longer on the page.");

    // 3. Atomic consume + APPROVED_TO_SUBMIT → SUBMITTING. A replay or a second worker stops here.
    const attempt = this.d.approvals.consumeAndStart(r.approvalId, r.applicationId, r.traceId);

    // 4. One click with the gate open for the bound origin only.
    const gate = gateFor(r.session.context);
    gate.sent.length = 0;
    gate.origin = origin;
    gate.open = true;
    let clickError: string | null = null;
    const before = taken.snapshot;
    try {
      const navigated = r.session.page
        .waitForEvent("framenavigated", { timeout: this.d.outcomeTimeoutMs ?? 15_000 })
        .catch(() => null);
      await handle.click({ timeout: 5_000, noWaitAfter: false });
      await navigated;
      await r.session.page
        .waitForLoadState("load", { timeout: this.d.outcomeTimeoutMs ?? 15_000 })
        .catch(() => undefined);
      await r.session.page.waitForTimeout(500);
    } catch (err) {
      clickError =
        err instanceof Error ? (err.message.split("\n")[0] ?? "click failed") : "click failed";
    } finally {
      gate.open = false;
      gate.origin = null;
    }

    // 5. Classify. Only clear confirmation is SUBMITTED; only a same-page validation error with nothing sent
    // returns to review; everything else is uncertain and left for the owner.
    let after: PageSnapshot | null;
    try {
      after = (await takeSnapshot(r.session.page, Date.now(), new Set([origin]))).snapshot;
    } catch {
      after = null;
    }
    const errors = (after?.elements ?? [])
      .filter((e) => e.invalid || e.errorText)
      .map(
        (e) => `${(e.groupLabel || e.label || e.name).slice(0, 80)}: ${e.errorText.slice(0, 120)}`,
      );
    const evidence: SubmissionEvidence = {
      url: after ? `${new URL(after.url).origin}${new URL(after.url).pathname}` : null,
      title: (after?.title ?? "").slice(0, 200),
      headings: (after?.headings ?? []).slice(0, 5).map((h) => h.slice(0, 200)),
      errors: errors.slice(0, 10),
      writesSent: gate.sent.length,
      note: clickError ? `click: ${clickError.slice(0, 200)}` : "",
    };
    let outcome: SubmissionOutcome;
    if (after && !clickError && r.adapter.isConfirmation(after)) outcome = "submitted";
    else if (
      after &&
      !clickError &&
      gate.sent.length === 0 &&
      errors.length > 0 &&
      r.adapter.pageKey(after) === r.adapter.pageKey(before)
    )
      outcome = "rejected_before_send";
    else outcome = "uncertain";

    this.d.attempts.finish(attempt.id, outcome, evidence);
    const ctx = {
      mode: this.d.mode,
      traceId: r.traceId,
      approvalId: r.approvalId,
      metadata: { outcome, ...evidence },
    };
    if (outcome === "submitted")
      this.d.applications.transition(r.applicationId, "SUBMITTED", {
        ...ctx,
        actor: "system",
        confirmationEvidence: [evidence.title, ...evidence.headings].join(" | ").slice(0, 300),
      });
    else if (outcome === "rejected_before_send")
      this.d.applications.transition(r.applicationId, "READY_FOR_REVIEW", {
        ...ctx,
        actor: "system",
        rejectedBeforeSend: true,
      });
    else
      this.d.applications.transition(r.applicationId, "SUBMISSION_UNCERTAIN", {
        ...ctx,
        actor: "system",
      });
    return { outcome, evidence };
  }
}
