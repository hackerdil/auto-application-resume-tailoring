"use client";

import { useState } from "react";
import type { AppAnswer, ApprovalState, BrowserState } from "@/lib/api";

const OUTCOME_TEXT: Record<string, string> = {
  submitted: "Submitted. The employer's site confirmed it.",
  uncertain: "Career Agent could not tell whether the application went through.",
  rejected_before_send:
    "The site rejected the form before anything was sent. Fix it in the window and review again.",
  failed: "The submission failed.",
};

/**
 * Phase 8 review and approval: one approval per application, bound to exactly this form, these answers, and
 * these files. Career Agent then presses the form's submit button once, in the window you reviewed.
 */
export function ApprovalPanel(props: {
  state: string;
  answers: AppAnswer[];
  browser: BrowserState;
  approval: ApprovalState;
  onRefresh: () => void;
  onApprove: () => void;
  onRevoke: () => void;
  onResolve: (outcome: "submitted" | "failed") => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const review = props.browser.session?.review ?? null;
  const live = props.browser.session !== null && props.browser.session.endedAt === null;
  const attempt = props.approval.attempt;
  const sent = props.answers.filter((a) => a.decision !== "prohibited" && a.finalValue !== null);

  if (props.state === "APPROVED_TO_SUBMIT" || props.state === "SUBMITTING")
    return (
      <section className="card" aria-live="polite">
        <p>
          <strong>Submitting…</strong> Keep the browser window open. Career Agent checks that
          nothing changed, then presses the submit button once.
        </p>
        {props.state === "APPROVED_TO_SUBMIT" && (
          <div className="actions">
            <button type="button" onClick={props.onRevoke}>
              Cancel approval
            </button>
          </div>
        )}
      </section>
    );

  if (
    ["SUBMITTED", "SUBMISSION_UNCERTAIN", "FAILED"].includes(props.state) ||
    attempt?.outcome === "rejected_before_send"
  )
    return (
      <section className="card" aria-live="polite">
        {attempt?.outcome && (
          <p className={attempt.outcome === "submitted" ? "status ok" : "notice"}>
            {OUTCOME_TEXT[attempt.outcome]}
          </p>
        )}
        {props.state === "SUBMITTED" && !attempt?.outcome && (
          <p className="status ok">Marked as submitted.</p>
        )}
        {attempt?.evidence && (
          <dl>
            <dt className="hint">Page after submitting</dt>
            <dd>
              {attempt.evidence.title || "(no title)"}
              {attempt.evidence.headings.length
                ? ` — ${attempt.evidence.headings.join(" · ")}`
                : ""}
            </dd>
            {attempt.evidence.errors.length > 0 && (
              <>
                <dt className="hint">Errors shown</dt>
                <dd>
                  <ul>
                    {attempt.evidence.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        )}
        {props.state === "SUBMISSION_UNCERTAIN" && (
          <>
            <p className="hint">
              Check the browser window or your email for a confirmation. Career Agent never retries
              on its own.
            </p>
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  props.onResolve("submitted");
                }}
              >
                It was submitted
              </button>
              <button
                type="button"
                onClick={() => {
                  props.onResolve("failed");
                }}
              >
                It was not submitted
              </button>
            </div>
          </>
        )}
      </section>
    );

  if (props.state !== "READY_FOR_REVIEW") return <p className="hint">Prepare the form first.</p>;

  const ready =
    live && review !== null && review.checklist.length === 0 && review.submitButton !== null;
  return (
    <section className="card">
      <p>
        What will be sent: {sent.length} answer(s) shown under <em>Answered</em>, your approved
        résumé
        {props.answers.some((a) => a.field.category === "cover_letter_file" && a.finalValue)
          ? " and cover letter"
          : ""}
        , and anything you entered directly in the browser window.
      </p>
      {review ? (
        <>
          <p className="hint">
            Form checked {new Date(review.takenAt).toLocaleTimeString()}
            {review.submitButton ? ` · submit button: “${review.submitButton}”` : ""}
          </p>
          {review.checklist.length > 0 && (
            <div className="notice">
              <strong>Before you can approve:</strong>
              <ul>
                {review.checklist.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="hint">The form has not been checked yet.</p>
      )}
      <div className="actions">
        <button type="button" disabled={!live || props.browser.busy} onClick={props.onRefresh}>
          {props.browser.busy ? "Checking…" : "Refresh review"}
        </button>
      </div>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!ready}
          onChange={(e) => {
            setConfirmed(e.target.checked);
          }}
        />{" "}
        I reviewed the form in the browser window. Press “{review?.submitButton ?? "Submit"}” once
        for me.
      </label>
      <div className="actions">
        <button
          className="primary"
          type="button"
          disabled={!ready || !confirmed || props.browser.busy}
          onClick={() => {
            setConfirmed(false);
            props.onApprove();
          }}
        >
          Approve and submit
        </button>
      </div>
      <p className="hint">
        The approval is single-use and expires in a few minutes. If anything changes after you
        approve — an answer, a file, or the form itself — it is cancelled and nothing is sent.
      </p>
    </section>
  );
}
