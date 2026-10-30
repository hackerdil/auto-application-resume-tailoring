# Approval and Submission Model

The only path to an external application submission. Implemented in deterministic code (`packages/security/approval`, `packages/browser/submission`); no model can reach it (ADR-007).

## 1. Preconditions for issuing a token

1. Mode is `review-each`.
2. Application state is `READY_FOR_REVIEW`.
3. Answer set complete; no `prohibited` field has a value; every `requires_user` field has a user-entered `finalValue`.
4. All résumé/cover-letter artifacts are verified and hashed.
5. A live browser session exists, is on an allowlisted origin, and a fresh snapshot was taken within the last N seconds.
6. Exactly one visible submit control was identified by the ATS adapter (generic path: owner must point at it via "Take over browser").
7. The owner pressed **Approve this application** on the review page for _this_ application (request carries CSRF token + idempotency key).

## 2. Binding

Canonical JSON (sorted keys, no whitespace) of:

```text
applicationId, ownerId, jobUrl, origin, jobId,
formSnapshotHash, answerSetHash, resumeArtifactHash, coverLetterArtifactHash|null,
submitControl {adapter, selectorFingerprint, accessibleName, frameUrl},
issuedAt, expiresAt
```

- `formSnapshotHash` = SHA-256 of the normalized snapshot: field identities, labels, types, required flags, options and _current values_, excluding volatile attributes (handles, timestamps).
- `answerSetHash` = SHA-256 of sorted `(fieldId, finalValue)` pairs.
- Stored: `token_hash = SHA-256(secret)`, `binding_json`, `binding_mac = HMAC-SHA256(k_approval, binding_json)` where `k_approval = HKDF(LOCAL_SESSION_SECRET, "approval-v1")`.

## 3. Token lifecycle

```text
issued ──(TTL APPROVAL_TTL_SECONDS, default 300 s)──▶ expired
   │ ──(edit answer | artifact change | navigation | DOM mutation | browser restart | cancel)──▶ revoked
   └──(submit request, binding matches, atomic consume)──▶ consumed
```

Issuing a new token revokes any earlier active token for the same application.

## 4. Submission algorithm (SubmissionService)

1. Look up approval by id; constant-time compare `SHA-256(secret)`; verify MAC; check not expired/revoked/consumed. Fail closed with typed `ApprovalError`.
2. Re-snapshot the page; recompute the binding from live state (page, answers, artifact files on disk); compare to the stored binding. Any difference → revoke token, application `APPROVED_TO_SUBMIT → READY_FOR_REVIEW`, stop.
3. In one transaction: consume the token (`UPDATE … WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now`, require exactly 1 row) and transition `APPROVED_TO_SUBMIT → SUBMITTING`. Zero rows → replay/race → fail closed. This makes a second concurrent submitter impossible.
4. Click the bound submit control exactly once through the adapter (not through any model tool).
5. Wait for the adapter's success predicates (confirmation URL pattern, success text, application ID element) with timeout.
6. Outcome:
   - predicate matched → `SUBMITTED`, store redacted confirmation evidence;
   - visible validation error on the same form and no request accepted → `FAILED` with reason (owner may re-review; new token required);
   - anything else (timeout, network error, navigation to unknown page) → `SUBMISSION_UNCERTAIN`; keep browser context open; never retry.
7. Audit event with approval id, artifact hashes, outcome evidence.

## 5. Test matrix (Phase 8)

No token · expired · replayed · wrong application · wrong owner · wrong artifact hash · wrong origin · snapshot mutation after approval · edited answer after approval · double-click concurrent submit · ambiguous network failure · success predicate · validation-error page · browser restart.
