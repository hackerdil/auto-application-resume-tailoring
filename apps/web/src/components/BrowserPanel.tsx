"use client";

import type { BrowserState } from "@/lib/api";

const STATUS_TEXT: Record<string, string> = {
  active: "Preparing the form…",
  handoff: "Your turn in the browser window",
  awaiting_input: "Waiting for you",
  ready: "Form filled — ready for your review",
  closed: "Browser closed",
  failed: "Preparation failed",
};

/**
 * Phase 7 browser preparation: Career Agent opens the employer's form in its own visible window and fills only your
 * finalized answers. It never submits, signs in, solves CAPTCHAs, or ticks consent boxes.
 */
export function BrowserPanel(props: {
  state: BrowserState;
  canPrepare: boolean;
  onPrepare: () => void;
  onClose: () => void;
}) {
  const s = props.state.session;
  const open = s !== null && s.endedAt === null;
  return (
    <section className="card" aria-live="polite">
      <p className="hint">
        Career Agent opens the application form in a separate browser window and fills in only the
        answers you approved. It never presses Submit, signs in for you, solves CAPTCHAs, or ticks
        consent boxes.
      </p>
      {s && (
        <>
          <p>
            <strong>{props.state.busy ? "Working…" : (STATUS_TEXT[s.status] ?? s.status)}</strong>
            {s.lastUrl ? ` · ${new URL(s.lastUrl).host}` : ""}
            {` · ${s.adapter} form · ${s.steps} step(s)`}
          </p>
          {s.message && !props.state.busy && <p className="notice">{s.message}</p>}
          {s.checklist.length > 0 && !props.state.busy && (
            <ul>
              {s.checklist.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="actions">
        <button
          className="primary"
          type="button"
          disabled={props.state.busy || !props.canPrepare}
          onClick={props.onPrepare}
        >
          {props.state.busy ? "Working…" : open ? "Continue" : "Prepare in browser"}
        </button>
        {open && (
          <button type="button" disabled={props.state.busy} onClick={props.onClose}>
            Close browser
          </button>
        )}
      </div>
      {!props.canPrepare && (
        <p className="hint">Approve a résumé and choose or skip a cover letter first.</p>
      )}
    </section>
  );
}
