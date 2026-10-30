"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import {
  api,
  errorText,
  FACT_CATEGORIES,
  type Candidate,
  type Fact,
  type FactCategory,
  type ImportResult,
} from "@/lib/api";

const label = (c: string) => c.replace(/_/g, " ");

export default function FactBankPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [c, f] = await Promise.all([
      api<{ candidates: Candidate[] }>("GET", "/api/v1/fact-candidates"),
      api<{ facts: Fact[] }>("GET", "/api/v1/facts"),
    ]);
    setCandidates(c.candidates);
    setFacts(f.facts);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [refresh]);

  async function upload(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setStatus({ kind: "error", text: "Choose a PDF or Word (.docx) file first." });
      return;
    }
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    try {
      const r = await api<ImportResult>("POST", "/api/v1/resumes", form);
      setNotes(r.warnings);
      setStatus({
        kind: "ok",
        text: r.alreadyImported
          ? "This résumé was already imported."
          : `Found ${r.candidates.length} suggestions. Review each one below.`,
      });
      await refresh();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setStatus({ kind: "ok", text: ok });
      await refresh();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  };

  return (
    <>
      <h1>Fact bank</h1>
      <p className="lede">
        Only facts you confirm here are used for résumés and applications. Suggestions quote the
        exact line they came from so you can check them.
      </p>
      <Status state={status} />

      <section aria-labelledby="upload-h">
        <h2 id="upload-h">Import a résumé</h2>
        <form className="card row" onSubmit={(e) => void upload(e)}>
          <div>
            <label htmlFor="resume">
              Résumé file <span className="hint">PDF or Word (.docx), up to 10 MB</span>
            </label>
            <input
              id="resume"
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            />
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Reading…" : "Import"}
            </button>
          </div>
        </form>
        {notes.map((n) => (
          <p className="notice" key={n}>
            {n}
          </p>
        ))}
      </section>

      <section aria-labelledby="pending-h">
        <h2 id="pending-h">Suggestions to review ({candidates.length})</h2>
        {candidates.length === 0 && <p className="empty">No pending suggestions.</p>}
        {candidates.map((c) => (
          <CandidateCard
            key={c.id}
            c={c}
            onConfirm={(edits) =>
              act(
                () => api("POST", `/api/v1/fact-candidates/${c.id}/confirm`, edits),
                "Fact confirmed.",
              )
            }
            onReject={() =>
              act(
                () => api("POST", `/api/v1/fact-candidates/${c.id}/reject`),
                "Suggestion rejected.",
              )
            }
          />
        ))}
      </section>

      <section aria-labelledby="facts-h">
        <h2 id="facts-h">Verified facts ({facts.length})</h2>
        {facts.length === 0 && <p className="empty">No verified facts yet.</p>}
        {facts.map((f) => (
          <FactCard
            key={f.id}
            f={f}
            onCorrect={(claim) =>
              act(
                () => api("POST", `/api/v1/facts/${f.id}/corrections`, { claim }),
                "Fact corrected. The previous version is kept in history.",
              )
            }
          />
        ))}
        <AddFact onAdd={(body) => act(() => api("POST", "/api/v1/facts", body), "Fact added.")} />
      </section>
    </>
  );
}

function CandidateCard(props: {
  c: Candidate;
  onConfirm: (edits: {
    claim: string;
    category: FactCategory;
    sensitive: boolean;
  }) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const { c } = props;
  const [claim, setClaim] = useState(c.claim);
  const [category, setCategory] = useState<FactCategory>(c.category);
  const [sensitive, setSensitive] = useState(c.sensitive);
  return (
    <article className="card" aria-label={`Suggestion: ${c.claim}`}>
      <div>
        <span className="badge">{c.extractor === "model" ? "AI suggestion" : "rule-based"}</span>
        {c.sourceLocation && <span className="badge">{c.sourceLocation}</span>}
        {c.sensitive && <span className="badge sensitive">sensitive</span>}
      </div>
      <blockquote aria-label="From your résumé">{c.evidenceText}</blockquote>
      <div className="row">
        <div style={{ flex: "3 1 320px" }}>
          <label htmlFor={`claim-${c.id}`}>Fact</label>
          <textarea
            id={`claim-${c.id}`}
            value={claim}
            onChange={(e) => {
              setClaim(e.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor={`cat-${c.id}`}>Category</label>
          <select
            id={`cat-${c.id}`}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as FactCategory);
            }}
          >
            {FACT_CATEGORIES.map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
          <label className="check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(e) => {
                setSensitive(e.target.checked);
              }}
            />
            Sensitive
          </label>
        </div>
      </div>
      <div className="actions">
        <button
          className="primary"
          type="button"
          onClick={() => void props.onConfirm({ claim, category, sensitive })}
        >
          {claim.trim() === c.claim ? "Confirm" : "Confirm edited fact"}
        </button>
        <button className="danger" type="button" onClick={() => void props.onReject()}>
          Reject
        </button>
      </div>
    </article>
  );
}

function FactCard(props: { f: Fact; onCorrect: (claim: string) => Promise<void> }) {
  const { f } = props;
  const [editing, setEditing] = useState(false);
  const [claim, setClaim] = useState(f.claim);
  return (
    <article className="card">
      <div>
        <span className="badge">{label(f.category)}</span>
        <span className="badge">{f.source === "resume" ? "from résumé" : "confirmed by you"}</span>
        {f.sensitive && <span className="badge sensitive">sensitive · encrypted</span>}
      </div>
      {editing ? (
        <>
          <label htmlFor={`fix-${f.id}`}>Corrected fact</label>
          <textarea
            id={`fix-${f.id}`}
            value={claim}
            onChange={(e) => {
              setClaim(e.target.value);
            }}
          />
          <div className="actions">
            <button
              className="primary"
              type="button"
              disabled={!claim.trim() || claim === f.claim}
              onClick={() =>
                void props.onCorrect(claim).then(() => {
                  setEditing(false);
                })
              }
            >
              Save correction
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setClaim(f.claim);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: "8px 0" }}>{f.claim}</p>
          {f.evidenceText && <blockquote aria-label="Evidence">{f.evidenceText}</blockquote>}
          <button
            type="button"
            onClick={() => {
              setEditing(true);
            }}
          >
            Correct
          </button>
        </>
      )}
    </article>
  );
}

function AddFact(props: {
  onAdd: (b: { claim: string; category: FactCategory; sensitive: boolean }) => Promise<void>;
}) {
  const [claim, setClaim] = useState("");
  const [category, setCategory] = useState<FactCategory>("skill");
  const [sensitive, setSensitive] = useState(false);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void props.onAdd({ claim, category, sensitive }).then(() => {
          setClaim("");
        });
      }}
    >
      <h3 style={{ marginTop: 0 }}>Add a fact yourself</h3>
      <div className="row">
        <div style={{ flex: "3 1 320px" }}>
          <label htmlFor="new-claim">Fact</label>
          <textarea
            id="new-claim"
            value={claim}
            onChange={(e) => {
              setClaim(e.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor="new-cat">Category</label>
          <select
            id="new-cat"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as FactCategory);
            }}
          >
            {FACT_CATEGORIES.map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
          <label className="check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(e) => {
                setSensitive(e.target.checked);
              }}
            />
            Sensitive
          </label>
        </div>
      </div>
      <div className="actions">
        <button className="primary" type="submit" disabled={!claim.trim()}>
          Add fact
        </button>
      </div>
    </form>
  );
}
