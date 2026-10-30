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
import type { ElementHandle, Frame } from "playwright";
import { submitControlIdentity, type AtsAdapter } from "../adapters/index.js";
import { classifyControl } from "../controls.js";
import type { BrowserSession } from "../session.js";
import { takeSnapshot, type PageSnapshot, type SnapshotElement } from "../snapshot.js";
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

    // 2. Live state must reproduce the binding exactly. Anything that fails before the consume revokes the
    // approval, so it can never linger in APPROVED_TO_SUBMIT.
    const origin = new URL(stored.jobUrl).origin;
    let taken: Awaited<ReturnType<typeof takeSnapshot>>;
    let handle: ElementHandle;
    try {
      taken = await takeSnapshot(r.session.page, Date.now(), new Set([origin]));
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
      const found =
        controls.length === 1
          ? taken.handles.get((controls[0] as SnapshotElement).handle)
          : undefined;
      if (!found && !diffs.includes("submitControl")) diffs.push("submitControl");
      if (diffs.length || !found)
        throw new ApprovalError(
          "binding_mismatch",
          `Something changed after you approved (${diffs.join(", ")}). Review the application again.`,
        );
      handle = found.handle;
    } catch (err) {
      const why = err instanceof ApprovalError ? err.message : "the page could not be checked";
      this.d.approvals.revoke(r.applicationId, `binding mismatch: ${why.slice(0, 150)}`, r.traceId);
      throw err instanceof ApprovalError
        ? err
        : new ApprovalError(
            "binding_mismatch",
            "The page could not be checked. Review the application again.",
          );
    }

    // 3. Atomic consume + APPROVED_TO_SUBMIT → SUBMITTING. A replay or a second worker stops here.
    const attempt = this.d.approvals.consumeAndStart(r.approvalId, r.applicationId, r.traceId);

    // From here on, any failure ends in SUBMISSION_UNCERTAIN: the click may have happened.
    let outcome: SubmissionOutcome = "uncertain";
    let evidence: SubmissionEvidence = {
      url: null,
      title: "",
      headings: [],
      errors: [],
      writesSent: 0,
      note: "",
    };
    try {
      ({ outcome, evidence } = await this.clickAndClassify(r, origin, taken.snapshot, handle));
    } catch {
      evidence = { ...evidence, note: "The outcome could not be read after the click." };
    }
    this.finish(r, attempt.id, outcome, evidence);
    return { outcome, evidence };
  }

  /** Opens the gate for the bound origin, clicks once, closes the gate, and classifies what the page shows. */
  private async clickAndClassify(
    r: SubmitRequest,
    origin: string,
    before: PageSnapshot,
    handle: ElementHandle,
  ): Promise<SubmitResult> {
    const page = r.session.page;
    const gate = gateFor(r.session.context);
    gate.sent.length = 0;
    gate.origin = origin;
    let mainNavigations = 0;
    const onNav = (f: Frame) => {
      if (f === page.mainFrame()) mainNavigations++;
    };
    page.on("framenavigated", onNav);
    gate.open = true;
    let clickError: string | null = null;
    try {
      const navigated = page
        .waitForEvent("framenavigated", { timeout: this.d.outcomeTimeoutMs ?? 15_000 })
        .catch(() => null);
      await handle.click({ timeout: 5_000, noWaitAfter: false });
      await navigated;
      await page
        .waitForLoadState("load", { timeout: this.d.outcomeTimeoutMs ?? 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
    } catch (err) {
      clickError =
        err instanceof Error ? (err.message.split("\n")[0] ?? "click failed") : "click failed";
    } finally {
      gate.open = false;
      gate.origin = null;
      page.off("framenavigated", onNav);
    }

    let after: PageSnapshot | null;
    try {
      after = (await takeSnapshot(page, Date.now(), new Set([origin]))).snapshot;
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
    // SUBMITTED only with all of: a write actually sent, a page that changed, and confirmation wording that was
    // not already on the form. Page text alone can never mark an application submitted.
    const changed =
      after !== null &&
      (after.url !== before.url || r.adapter.pageKey(after) !== r.adapter.pageKey(before));
    if (
      after &&
      !clickError &&
      gate.sent.length > 0 &&
      changed &&
      r.adapter.isConfirmation(after) &&
      !r.adapter.isConfirmation(before)
    )
      return { outcome: "submitted", evidence };
    // Back to review only when provably nothing left: no write, no navigation, same document, errors shown.
    if (
      after &&
      !clickError &&
      gate.sent.length === 0 &&
      mainNavigations === 0 &&
      after.url === before.url &&
      errors.length > 0
    )
      return { outcome: "rejected_before_send", evidence };
    return { outcome: "uncertain", evidence };
  }

  private finish(
    r: SubmitRequest,
    attemptId: string,
    outcome: SubmissionOutcome,
    evidence: SubmissionEvidence,
  ): void {
    this.d.attempts.finish(attemptId, outcome, evidence);
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
  }
}
