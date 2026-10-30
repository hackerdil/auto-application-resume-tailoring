"use client";

import type { MatchResponse, RequirementAssessment } from "@/lib/api";

const DIMENSION_LABELS: Record<string, string> = {
  roleAlignment: "Role / title",
  mustHaveSkills: "Listed requirements",
  experienceEvidence: "Requirements and nice-to-haves",
  seniorityAlignment: "Seniority",
  domainAlignment: "Domain overlap",
  locationFit: "Location / work mode",
  authorizationFit: "Work authorization",
  compensationFit: "Compensation",
  preferenceFit: "Your exclusions",
};

const STATUS_TEXT: Record<RequirementAssessment["status"], string> = {
  met: "✓ supported",
  partial: "◐ partly supported",
  missing: "✗ not found",
  unknown: "? unknown",
};

export function MatchPanel({ data }: { data: MatchResponse }) {
  const m = data.match;
  if (!m) return <p className="empty">{data.scoring ? "Scoring…" : "Not scored yet."}</p>;
  return (
    <section aria-labelledby="match-h">
      <h2 id="match-h">
        Match: {m.total}/100 · {m.verdict}
      </h2>
      <p className="hint">
        An internal relevance heuristic computed from your verified facts and preferences. It is not
        an employer ATS score and does not predict hiring. Scored{" "}
        {new Date(m.createdAt).toLocaleString()} (
        {m.meta.mode === "deterministic"
          ? "rule-based evidence"
          : `AI-assisted via ${m.meta.provider ?? "?"}`}
        ).
      </p>
      {data.stale && (
        <p className="notice">
          Your facts, profile, or this posting changed since this score. Re-score to update it.
        </p>
      )}
      {m.meta.modelSkippedReason && <p className="hint">{m.meta.modelSkippedReason}</p>}
      {m.hardFilterReasons.length > 0 && (
        <div className="notice" role="note">
          <strong>Disqualified:</strong>
          <ul>
            {m.hardFilterReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <p>{m.explanation}</p>

      <table className="card" style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption className="hint" style={{ textAlign: "left" }}>
          Score by dimension (weight in brackets)
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: "left" }}>
              Dimension
            </th>
            <th scope="col" style={{ textAlign: "right" }}>
              Score
            </th>
            <th scope="col" style={{ textAlign: "left", paddingLeft: 12 }}>
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(m.dimensions).map(([k, v]) => (
            <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
              <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "6px 0" }}>
                {DIMENSION_LABELS[k] ?? k}{" "}
                <span className="hint">[{Math.round((m.meta.weights[k] ?? 0) * 100)}%]</span>
              </th>
              <td style={{ textAlign: "right" }}>
                {v.unknown ? <span className="hint">50 (unknown)</span> : v.score}
              </td>
              <td style={{ paddingLeft: 12 }} className="hint">
                {v.rationale}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Requirements and your evidence</h3>
      {m.requirements.length === 0 && (
        <p className="empty">The posting lists no requirements in a recognizable section.</p>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {m.requirements.map((r) => (
          <li key={r.key} className="card">
            <span className="badge">{r.kind}</span>
            <span className="badge">
              {r.source === "model" ? "AI-judged, citations checked" : "word match"}
            </span>
            <strong>{STATUS_TEXT[r.status]}</strong> — {r.text}
            <p className="hint" style={{ margin: "4px 0" }}>
              {r.rationale}
            </p>
            {r.factIds.length > 0 && (
              <ul aria-label="Supporting facts">
                {r.factIds.map((id) => (
                  <li key={id}>{data.facts[id]?.claim ?? "(fact no longer active)"}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {m.unknowns.length > 0 && (
        <>
          <h3>Needs your input</h3>
          <ul>
            {m.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      )}
      {m.modelExplanation && (
        <>
          <h3>AI summary</h3>
          <p className="hint">
            Written by {m.meta.provider ?? "the model"}; not used for the score.
          </p>
          <blockquote>{m.modelExplanation}</blockquote>
        </>
      )}
    </section>
  );
}
