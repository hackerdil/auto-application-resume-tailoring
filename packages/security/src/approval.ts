import {
  ApprovalBinding,
  ApprovalError,
  assertModeAllows,
  PolicyError,
  uuidv7,
  type ApplicationAnswer,
  type ApplicationRepository,
  type ApprovalRepository,
  type AuditRepository,
  type BindingMaterial,
  type OperatingMode,
  type SubmissionAttemptRecord,
  type SubmissionAttemptRepository,
  type SubmitControlIdentity,
} from "@career-agent/domain";
import { FieldCipher } from "./encryption.js";
import {
  canonicalJson,
  deriveKey,
  hmacSha256Hex,
  randomTokenBase64Url,
  sha256Hex,
  timingSafeEqualHex,
} from "./hashing.js";

/** k_approval = HKDF(LOCAL_SESSION_SECRET, "approval-v1") (docs/APPROVAL_MODEL.md §2). */
export const approvalKey = (sessionSecret: Uint8Array): Buffer =>
  deriveKey(sessionSecret, "approval-v1");

/**
 * The token secret travels from the API to the worker inside the submit task, sealed with a key derived from
 * LOCAL_SESSION_SECRET and bound to the approval id, so the database never holds it in the clear.
 */
export function sealApprovalSecret(
  sessionSecret: Uint8Array,
  approvalId: string,
  secret: string,
): string {
  return transportCipher(sessionSecret).encrypt(secret, `approval-secret:${approvalId}`);
}

export function openApprovalSecret(
  sessionSecret: Uint8Array,
  approvalId: string,
  sealed: string,
): string {
  try {
    return transportCipher(sessionSecret).decrypt(sealed, `approval-secret:${approvalId}`);
  } catch {
    throw new ApprovalError("invalid", "The approval token could not be read.");
  }
}

const transportCipher = (secret: Uint8Array) =>
  new FieldCipher("t1", { t1: deriveKey(secret, "approval-transport-v1") });

/** SHA-256 over sorted (fieldId, finalValue) pairs (docs/APPROVAL_MODEL.md §2). */
export function answerSetHash(
  pairs: readonly { fieldId: string; finalValue: string | null }[],
): string {
  const sorted = [...pairs]
    .map((p) => [p.fieldId, p.finalValue] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(canonicalJson(sorted));
}

/** The one place binding material is assembled, for both approval (API) and the pre-click check (worker). */
export function buildBindingMaterial(i: {
  applicationId: string;
  ownerId: string;
  job: { id: string; applyUrl: string | null; sourceUrl: string };
  answers: readonly ApplicationAnswer[];
  resumeHash: string;
  coverLetterHash: string | null;
  formSnapshotHash: string;
  origin: string;
  submitControl: SubmitControlIdentity;
}): BindingMaterial {
  return {
    applicationId: i.applicationId,
    ownerId: i.ownerId,
    jobUrl: i.job.applyUrl ?? i.job.sourceUrl,
    origin: i.origin,
    jobId: i.job.id,
    formSnapshotHash: i.formSnapshotHash,
    answerSetHash: answerSetHash(
      i.answers.map((a) => ({ fieldId: a.field.id, finalValue: a.finalValue })),
    ),
    resumeArtifactHash: i.resumeHash,
    coverLetterArtifactHash: i.coverLetterHash,
    submitControl: i.submitControl,
  };
}

export interface ApprovalServiceDeps {
  approvals: ApprovalRepository;
  applications: ApplicationRepository;
  attempts: SubmissionAttemptRepository;
  audit: AuditRepository;
  /** Runs `fn` atomically. */
  uow: <T>(fn: () => T) => T;
  key: Buffer;
  ttlSeconds: number;
  mode: OperatingMode;
  now?: () => Date;
}

/**
 * Issues, verifies, consumes, and revokes single-use approvals (docs/APPROVAL_MODEL.md). Deterministic: no model
 * reaches it. Every failure is a typed ApprovalError and fails closed.
 */
export class ApprovalService {
  private readonly now: () => Date;

  constructor(private readonly d: ApprovalServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** The owner pressed Approve. Revokes earlier approvals and moves the application to APPROVED_TO_SUBMIT. */
  issue(
    ownerId: string,
    material: BindingMaterial,
    traceId: string,
  ): { approvalId: string; secret: string; binding: ApprovalBinding } {
    assertModeAllows(this.d.mode, "issue_approval");
    const app = this.d.applications.get(material.applicationId);
    if (!app || app.userId !== ownerId || material.ownerId !== ownerId)
      throw new ApprovalError("wrong_application");
    if (app.state !== "READY_FOR_REVIEW")
      throw new PolicyError(
        `Only an application ready for review can be approved (it is ${app.state}).`,
      );
    const issued = this.now();
    const binding = ApprovalBinding.parse({
      ...material,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + this.d.ttlSeconds * 1000).toISOString(),
    });
    const bindingJson = canonicalJson(binding);
    const secret = randomTokenBase64Url(32);
    const id = uuidv7();
    this.d.uow(() => {
      this.d.approvals.issue({
        id,
        applicationId: app.id,
        tokenHash: sha256Hex(secret),
        bindingJson,
        bindingMac: hmacSha256Hex(this.d.key, bindingJson),
        issuedAt: binding.issuedAt,
        expiresAt: binding.expiresAt,
      });
      this.d.applications.transition(app.id, "APPROVED_TO_SUBMIT", {
        actor: "user",
        mode: this.d.mode,
        activeApprovalId: id,
        approvalId: id,
        traceId,
        metadata: { expiresAt: binding.expiresAt },
      });
    });
    return { approvalId: id, secret, binding };
  }

  /** Checks the token, MAC, application, and lifetime; returns the stored binding. Does not consume. */
  verify(approvalId: string, secret: string, applicationId: string): ApprovalBinding {
    const rec = this.d.approvals.get(approvalId);
    if (!rec) throw new ApprovalError("missing");
    if (!timingSafeEqualHex(sha256Hex(secret), rec.tokenHash)) throw new ApprovalError("invalid");
    if (!timingSafeEqualHex(hmacSha256Hex(this.d.key, rec.bindingJson), rec.bindingMac))
      throw new ApprovalError("invalid", "The approval record was altered.");
    if (rec.applicationId !== applicationId) throw new ApprovalError("wrong_application");
    if (rec.consumedAt) throw new ApprovalError("consumed");
    if (rec.revokedAt) throw new ApprovalError("revoked");
    if (Date.parse(rec.expiresAt) <= this.now().getTime()) throw new ApprovalError("expired");
    const binding = ApprovalBinding.parse(JSON.parse(rec.bindingJson));
    if (binding.applicationId !== applicationId) throw new ApprovalError("wrong_application");
    return binding;
  }

  /**
   * Atomically consumes the approval, moves APPROVED_TO_SUBMIT → SUBMITTING, and records the attempt. Zero rows
   * consumed (replay, race, expiry, revocation) → nothing changes and ApprovalError is thrown.
   */
  consumeAndStart(
    approvalId: string,
    applicationId: string,
    traceId: string,
  ): SubmissionAttemptRecord {
    assertModeAllows(this.d.mode, "submit");
    return this.d.uow(() => {
      if (!this.d.approvals.consume(approvalId, this.now().toISOString()))
        throw new ApprovalError("consumed", "The approval was already used, revoked, or expired.");
      this.d.applications.transition(applicationId, "SUBMITTING", {
        actor: "system",
        mode: this.d.mode,
        activeApprovalId: approvalId,
        approvalId,
        traceId,
      });
      return this.d.attempts.start(applicationId, approvalId);
    });
  }

  /** Revokes any active approval and returns an approved application to review. */
  revoke(applicationId: string, reason: string, traceId: string): boolean {
    return this.d.uow(() => {
      const n = this.d.approvals.revokeAllActive(applicationId, reason);
      const app = this.d.applications.get(applicationId);
      if (app?.state === "APPROVED_TO_SUBMIT")
        this.d.applications.transition(applicationId, "READY_FOR_REVIEW", {
          actor: "system",
          mode: this.d.mode,
          traceId,
          metadata: { revoked: reason.slice(0, 120) },
        });
      return n > 0;
    });
  }
}
