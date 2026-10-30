"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { BrowserPanel } from "@/components/BrowserPanel";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, STATE_TEXT, type AppAnswer, type AppDetail } from "@/lib/api";

const DECISION_TEXT: Record<AppAnswer["decision"], string> = {
  auto_fill: "filled from your data",
  needs_review: "check this",
  requires_user: "needs your answer",
  prohibited: "you do this in the form",
};

const SENSITIVITY_TEXT: Record<AppAnswer["sensitivity"], string> = {
  none: "",
  personal: "personal",
  sensitive: "sensitive",
  protected: "protected",
};

function provenanceText(a: AppAnswer): string {
  const p = a.provenance;
  switch (p.kind) {
    case "profile":
      return "From your profile.";
    case "saved_answer":
      return "From your saved answers.";
    case "owner_default":
      return p.note ?? "Your default.";
    case "artifact":
      return p.label ?? "Approved file.";
    case "facts":
      return "From your verified facts:";
    case "draft":
      return "Drafted from your facts, checked sentence by sentence:";
    case "user":
      return "Your answer.";
    default:
      return "";
  }
}

function Question(props: {
  a: AppAnswer;
  onAnswer: (body: unknown) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const { a } = props;
  const [value, setValue] = useState(a.finalValue ?? a.proposedValue ?? "");
  const choice = a.field.options.length > 0 && a.field.type !== "checkbox";
  const id = `q-${a.field.id}`;
  return (
    <article className="card" aria-labelledby={`${id}-label`}>
      <div>
        <span
          className={`badge ${a.decision === "requires_user" || a.decision === "prohibited" ? "sensitive" : ""}`}
        >
          {DECISION_TEXT[a.decision]}
        </span>
        {SENSITIVITY_TEXT[a.sensitivity] && (
          <span className="badge">{SENSITIVITY_TEXT[a.sensitivity]}</span>
        )}
        {a.field.required && <span className="badge">required</span>}
      </div>
      <h3 id={`${id}-label`} style={{ margin: "8px 0 4px" }}>
        {a.field.label}
      </h3>
      {a.notes.map((n) => (
        <p className="hint" key={n}>
          {n}
        </p>
      ))}
      {a.decision === "prohibited" ? (
        <p className="hint">
          Career Agent never fills this. You will complete it yourself in the application form.
        </p>
      ) : (
        <>
          {a.proposedValue !== null && a.finalValue === null && (
            <div className="notice">
              <strong>Proposed:</strong>{" "}
              <span style={{ whiteSpace: "pre-wrap" }}>{a.proposedValue}</span>
              <p className="hint" style={{ margin: "4px 0" }}>
                {provenanceText(a)}
              </p>
              {a.sources.length > 0 && (
                <ul className="hint">
                  {a.sources.map((s) => (
                    <li key={s.id}>{s.claim ?? "(fact no longer active)"}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="primary"
                onClick={() => void props.onAnswer({ useProposal: true })}
              >
                Use this answer
              </button>
            </div>
          )}
          {a.finalValue !== null && (
            <p>
              <strong>Answer:</strong>{" "}
              <span style={{ whiteSpace: "pre-wrap" }}>
                {a.field.type === "file" ? `${a.finalValue} (${provenanceText(a)})` : a.finalValue}
              </span>{" "}
              <span className="hint">
                ({a.finalValueSetBy === "user" ? "set by you" : "filled from your data"})
              </span>
            </p>
          )}
          {a.field.type !== "file" && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void props.onAnswer({ value: value.trim() ? value : null });
              }}
            >
              <div style={{ flex: "3 1 300px" }}>
                <label htmlFor={id}>Your answer</label>
                {choice ? (
                  <select
                    id={id}
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                    }}
                  >
                    <option value="">Choose…</option>
                    {a.field.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : a.field.type === "textarea" ? (
                  <textarea
                    id={id}
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                    }}
                  />
                ) : (
                  <input
                    id={id}
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                    }}
                  />
                )}
              </div>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit">Save answer</button>
              </div>
            </form>
          )}
        </>
      )}
      {a.field.origin !== "page" && (
        <button
          type="button"
          className="danger"
          style={{ marginTop: 8 }}
          onClick={() => void props.onRemove()}
        >
          Remove question
        </button>
      )}
    </article>
  );
}

function Workspace() {
  const id = useSearchParams().get("id") ?? "";
  const [d, setD] = useState<AppDetail | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [label, setLabel] = useState("");
  const [qType, setQType] = useState("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");

  const load = useCallback(async () => {
    setD(await api<AppDetail>("GET", `/api/v1/applications/detail?id=${encodeURIComponent(id)}`));
  }, [id]);
  useEffect(() => {
    load().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [load]);
  useEffect(() => {
    if (!d?.coverLetterDrafting && !d?.browser.busy) return;
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 2500);
    return () => {
      clearInterval(t);
    };
  }, [d?.coverLetterDrafting, d?.browser.busy, load]);

  const act = async (path: string, body?: unknown, ok = "Saved.") => {
    try {
      const r = await api<{ note?: string | null }>("POST", path, body);
      setStatus({ kind: "ok", text: r.note ?? ok });
      await load();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  };
  if (!d) return <Status state={status} />;
  const base = `/api/v1/applications/${d.application.id}`;
  const approved = d.resumes.filter((r) => r.status === "approved");
  const groups: [string, AppAnswer[]][] = [
    [
      "Needs your answer",
      d.answers.filter((a) => a.decision === "requires_user" && a.finalValue === null),
    ],
    [
      "Check these",
      d.answers.filter((a) => a.decision === "needs_review" && a.finalValue === null),
    ],
    ["Answered", d.answers.filter((a) => a.decision !== "prohibited" && a.finalValue !== null)],
    ["You complete these in the form", d.answers.filter((a) => a.decision === "prohibited")],
    [
      "Optional, unanswered",
      d.answers.filter((a) => a.decision === "auto_fill" && a.finalValue === null),
    ],
  ];

  return (
    <>
      <p>
        <Link href="/applications">← All applications</Link> ·{" "}
        <Link href={`/jobs/detail?id=${encodeURIComponent(d.job.id)}`}>Job details</Link>
      </p>
      <h1>
        {d.job.title} · {d.job.company}
      </h1>
      <p className="lede">
        Status: <strong>{STATE_TEXT[d.application.state] ?? d.application.state}</strong>. Nothing
        is ever sent to the employer without your final approval, which arrives in a later phase.
      </p>
      <Status state={status} />

      <h2>1. Résumé</h2>
      {approved.length === 0 ? (
        <p className="notice">
          No approved résumé for this job yet.{" "}
          <Link href={`/jobs/detail?id=${encodeURIComponent(d.job.id)}`}>
            Tailor and approve one
          </Link>
          .
        </p>
      ) : (
        <fieldset className="card" style={{ border: "1px solid var(--border)" }}>
          <legend>Approved résumés</legend>
          {approved.map((r) => (
            <label className="check" key={r.id} style={{ display: "flex" }}>
              <input
                type="radio"
                name="resume"
                aria-label={`Résumé from ${new Date(r.createdAt).toLocaleString()}, ${r.length}`}
                checked={d.application.resumeVersionId === r.id}
                onChange={() =>
                  void act(`${base}/resume`, { resumeVersionId: r.id }, "Résumé selected.")
                }
              />
              {new Date(r.createdAt).toLocaleString()} · {r.length} ·{" "}
              <Link href={`/resumes/detail?id=${r.id}`}>&nbsp;view</Link>
            </label>
          ))}
        </fieldset>
      )}

      <h2>2. Cover letter</h2>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={d.coverLetterDrafting}
          onClick={() => void act(`${base}/cover-letter/draft`, {}, "Drafting started.")}
        >
          {d.coverLetterDrafting ? "Drafting…" : "Draft a cover letter"}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={d.application.coverLetterSkipped}
            onChange={(e) => void act(`${base}/cover-letter/skip`, { skip: e.target.checked })}
          />
          Apply without a cover letter
        </label>
      </div>
      {d.coverLetters.map((c) => (
        <article className="card" key={c.id}>
          <span className="badge">{c.status.replace("_", " ")}</span>
          {d.application.coverLetterVersionId === c.id && (
            <span className="badge">used in this application</span>
          )}
          <span className="hint"> {new Date(c.createdAt).toLocaleString()}</span>
          {c.notes.map((n) => (
            <p className="hint" key={n}>
              {n}
            </p>
          ))}
          <div aria-label="Letter text">
            {c.segments.map((s, i) => (
              <p key={i} style={{ margin: "4px 0" }}>
                <span className="badge">
                  {s.kind === "fact"
                    ? "from your facts"
                    : s.kind === "motivation"
                      ? "motivation: edit to your real reasons"
                      : "standard"}
                </span>{" "}
                {s.text}
                {s.sources.length > 0 && (
                  <span className="hint"> — {s.sources.filter(Boolean).join(" + ")}</span>
                )}
              </p>
            ))}
          </div>
          {c.dropped.length > 0 && (
            <p className="hint">{c.dropped.length} sentence(s) removed by verification.</p>
          )}
          {c.checks
            .filter((x) => !x.ok)
            .map((x) => (
              <p className="status error" key={x.name}>
                {x.detail}
              </p>
            ))}
          <div className="actions">
            {c.artifacts.pdf && (
              <a className="button" href={`/api/v1/artifacts/${c.artifacts.pdf.id}/download`}>
                PDF
              </a>
            )}
            {c.artifacts.docx && (
              <a className="button" href={`/api/v1/artifacts/${c.artifacts.docx.id}/download`}>
                Word
              </a>
            )}
            {c.status === "draft" && (
              <>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    void act(
                      `${base}/cover-letters/${c.id}/approve`,
                      undefined,
                      "Cover letter approved.",
                    )
                  }
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void act(`${base}/cover-letters/${c.id}/reject`, undefined, "Rejected.")
                  }
                >
                  Reject
                </button>
              </>
            )}
          </div>
        </article>
      ))}

      <h2>3. Questions</h2>
      <div className="actions">
        <button
          type="button"
          onClick={() => void act(`${base}/questions`, { common: true }, "Common questions added.")}
        >
          Add common questions
        </button>
        <button
          type="button"
          onClick={() => void act(`${base}/draft-answers`, {}, "Drafts updated.")}
        >
          Draft written answers with AI
        </button>
      </div>
      {d.answers.length === 0 && (
        <p className="empty">
          No questions yet. Add the common set or the questions from the posting.
        </p>
      )}
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title}>
            <h3>
              {title} ({list.length})
            </h3>
            {list.map((a) => (
              <Question
                key={`${a.field.id}-${a.finalValue ?? ""}-${a.proposedValue ?? ""}`}
                a={a}
                onAnswer={(body) => act(`${base}/questions/${a.field.id}/answer`, body)}
                onRemove={() =>
                  act(`${base}/questions/${a.field.id}/remove`, undefined, "Question removed.")
                }
              />
            ))}
          </section>
        ) : null,
      )}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            `${base}/questions`,
            {
              questions: [
                {
                  label,
                  type: qType,
                  required,
                  options: options
                    .split("\n")
                    .map((o) => o.trim())
                    .filter(Boolean),
                },
              ],
            },
            "Question added.",
          ).then(() => {
            setLabel("");
            setOptions("");
          });
        }}
      >
        <h3 style={{ marginTop: 0 }}>Add a question from the posting</h3>
        <label htmlFor="q-label">Question</label>
        <input
          id="q-label"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
          required
        />
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label htmlFor="q-type">Type</label>
            <select
              id="q-type"
              value={qType}
              onChange={(e) => {
                setQType(e.target.value);
              }}
            >
              {[
                "text",
                "textarea",
                "select",
                "radio",
                "checkbox",
                "email",
                "tel",
                "url",
                "date",
                "number",
                "file",
              ].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="q-options">
              Options <span className="hint">one per line, for choices</span>
            </label>
            <textarea
              id="q-options"
              value={options}
              onChange={(e) => {
                setOptions(e.target.value);
              }}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => {
              setRequired(e.target.checked);
            }}
          />
          Required
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            Add question
          </button>
        </div>
      </form>

      <h2>4. Consistency check</h2>
      {d.consistency.length === 0 ? (
        <p className="status ok">
          No problems found across your résumé, cover letter, and answers.
        </p>
      ) : (
        <ul>
          {d.consistency.map((f) => (
            <li key={`${f.location}-${f.detail}`}>
              <span className={`badge ${f.severity === "high" ? "sensitive" : ""}`}>
                {f.severity}
              </span>{" "}
              {f.location}: {f.detail}
            </li>
          ))}
        </ul>
      )}
      <h2>5. Fill the application form</h2>
      <BrowserPanel
        state={d.browser}
        canPrepare={[
          "READY_TO_PREPARE",
          "PREPARING",
          "AWAITING_USER_INPUT",
          "READY_FOR_REVIEW",
        ].includes(d.application.state)}
        onPrepare={() => void act(`${base}/browser/prepare`, undefined, "Opening the form…")}
        onClose={() => void act(`${base}/browser/close`, undefined, "Closing the browser…")}
      />
      <p className="hint">
        {d.answers.length === 0
          ? "No questions yet."
          : d.answersComplete
            ? "All required questions are answered."
            : `${d.pending.length} question(s) still need you.`}
      </p>
    </>
  );
}

export default function ApplicationPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Workspace />
    </Suspense>
  );
}
