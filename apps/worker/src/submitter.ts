import { snapshotHash } from "@career-agent/browser";
import {
  submitControlIdentity,
  SubmissionService,
  type SubmitResult,
} from "@career-agent/browser/submission";
import type { Store } from "@career-agent/db";
import type { FileArtifactStore } from "@career-agent/documents";
import {
  ApprovalError,
  PolicyError,
  type ApplicationService,
  type OperatingMode,
} from "@career-agent/domain";
import type { Logger } from "@career-agent/observability";
import { ApprovalService, buildBindingMaterial, openApprovalSecret } from "@career-agent/security";
import type { BrowserPreparer } from "./preparer.js";

export interface SubmitterOptions {
  store: Store;
  applications: ApplicationService;
  approvals: ApprovalService;
  preparer: BrowserPreparer;
  files: FileArtifactStore;
  ownerId: string;
  sessionSecret: Buffer;
  mode: OperatingMode;
  logger: Logger;
  outcomeTimeoutMs?: number;
}

/**
 * Runs the owner-approved submission in the window that was prepared (Phase 8). Approvals that were active when
 * the worker started are revoked: their browser is gone ("browser restart", docs/APPROVAL_MODEL.md §3).
 */
export class Submitter {
  private readonly service: SubmissionService;

  constructor(private readonly o: SubmitterOptions) {
    this.service = new SubmissionService({
      approvals: o.approvals,
      applications: o.store.applications,
      attempts: o.store.submissionAttempts,
      audit: o.store.audit,
      mode: o.mode,
      ...(o.outcomeTimeoutMs ? { outcomeTimeoutMs: o.outcomeTimeoutMs } : {}),
    });
    for (const a of o.store.applications.list(o.ownerId))
      if (a.state === "APPROVED_TO_SUBMIT")
        o.approvals.revoke(a.id, "browser restarted", "startup");
  }

  async submit(
    applicationId: string,
    approvalId: string,
    sealedSecret: string,
    traceId: string,
  ): Promise<SubmitResult> {
    const live = this.o.preparer.liveFor(applicationId);
    if (!live) {
      this.o.approvals.revoke(applicationId, "browser closed", traceId);
      throw new ApprovalError("binding_mismatch", "The browser window is no longer open.");
    }
    const secret = openApprovalSecret(this.o.sessionSecret, approvalId, sealedSecret);
    const verify = (artifactId: string, sha256: string) => {
      const art = this.o.store.artifacts.get(artifactId);
      if (!art || art.sha256 !== sha256) throw new PolicyError("An approved file is missing.");
      this.o.files.read(art.storagePath, sha256); // throws when the bytes changed
    };
    const result = await this.service.submit({
      approvalId,
      secret,
      applicationId,
      traceId,
      session: live.session,
      adapter: live.adapter,
      liveMaterial: (s) => {
        const m = this.o.applications.submissionMaterials(this.o.ownerId, applicationId, verify);
        const control = live.adapter.submitControl(s);
        return buildBindingMaterial({
          applicationId,
          ownerId: this.o.ownerId,
          job: m.job,
          answers: m.answers,
          resumeHash: m.resumeHash,
          coverLetterHash: m.coverLetterHash,
          formSnapshotHash: snapshotHash(s),
          origin: s.origin,
          submitControl: control
            ? submitControlIdentity(live.adapter, control)
            : {
                adapter: live.adapter.id,
                selectorFingerprint: "none",
                accessibleName: "",
                frameUrl: "",
              },
        });
      },
    });
    this.o.logger.info(
      { outcome: result.outcome, writesSent: result.evidence.writesSent },
      "submission finished",
    );
    return result;
  }
}
