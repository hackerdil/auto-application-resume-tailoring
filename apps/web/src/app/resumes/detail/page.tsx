"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, type ResumeDetail } from "@/lib/api";

const TRANSFORM: Record<string, string> = {
  select: "copied from your fact",
  reorder: "copied from your fact",
  shorten: "shortened",
  rephrase: "reworded",
  combine: "combined from several facts",
};

function Diff({ parts }: { parts: NonNullable<ResumeDetail["provenance"][number]["diff"]> }) {
  return (
    <p className="hint" aria-label="Changes from your fact">
      {parts.map((p, i) =>
        p.op === "eq" ? (
          <span key={i}>{p.text}</span>
        ) : p.op === "del" ? (
          <del key={i} style={{ color: "var(--danger)" }}>
            {p.text}
          </del>
        ) : (
          <ins key={i} style={{ color: "var(--ok)" }}>
            {p.text}
          </ins>
        ),
      )}
    </p>
  );
}

function Review() {
  const id = useSearchParams().get("id") ?? "";
  const [d, setD] = useState<ResumeDetail | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const load = useCallback(async () => {
    setD(
      await api<ResumeDetail>(
        "GET",
        `/api/v1/tailored-resumes/detail?id=${encodeURIComponent(id)}`,
      ),
    );
  }, [id]);
  useEffect(() => {
    load().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [load]);
  if (!d) return <Status state={status} />;
  const prov = new Map(d.provenance.map((p) => [p.bulletId, p]));
  const r = d.resume;
  const decide = (decision: "approve" | "reject") => {
    void api("POST", `/api/v1/tailored-resumes/${d.id}/${decision}`)
      .then(() => {
        setStatus({
          kind: "ok",
          text:
            decision === "approve"
              ? "Approved. It can be used in an application for this job."
              : "Rejected.",
        });
        return load();
      })
      .catch((e: unknown) => {
        setStatus({ kind: "error", text: errorText(e) });
      });
  };
  const failed = d.checks.filter((c) => !c.ok);
  return (
    <>
      {d.jobId && (
        <p>
          <Link href={`/jobs/detail?id=${encodeURIComponent(d.jobId)}`}>← Back to the job</Link>
        </p>
      )}
      <h1>Review tailored résumé</h1>
      <p className="lede">
        {d.length === "one-page" ? "One page" : "Full length"} ·{" "}
        {d.mode === "deterministic"
          ? "your facts, verbatim, ordered for this job"
          : `written with ${r.meta.generator ?? "AI"}, reviewed by ${r.meta.reviewer ?? "no independent reviewer"}`}{" "}
        · status: <strong>{d.status.replace("_", " ")}</strong>
      </p>
      <Status state={status} />
      {r.meta.notes.map((n) => (
        <p className="hint" key={n}>
          {n}
        </p>
      ))}
      {failed.length > 0 && (
        <div className="notice" role="alert">
          <strong>Rendering checks failed; this version cannot be approved:</strong>
          <ul>
            {failed.map((c) => (
              <li key={c.name}>{c.detail}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        {d.artifacts.pdf && (
          <a className="button" href={`/api/v1/artifacts/${d.artifacts.pdf.id}/download`}>
            Download PDF
          </a>
        )}
        {d.artifacts.docx && (
          <a className="button" href={`/api/v1/artifacts/${d.artifacts.docx.id}/download`}>
            Download Word
          </a>
        )}
        <button
          type="button"
          className="primary"
          disabled={d.status !== "draft"}
          onClick={() => {
            decide("approve");
          }}
        >
          Approve this résumé
        </button>
        <button
          type="button"
          className="danger"
          disabled={d.status !== "draft"}
          onClick={() => {
            decide("reject");
          }}
        >
          Reject
        </button>
      </div>

      <h2>Content and where each line comes from</h2>
      <article className="card">
        <h3 style={{ marginTop: 0 }}>
          {r.header.name || "(name hidden by your sharing settings)"}
        </h3>
        <p className="hint">
          {[...r.header.contact, ...r.header.links.map((l) => l.url)].join(" · ") ||
            "No contact details shared (only fields set to “Share on applications” appear)."}
        </p>
        {r.summary && <p>{r.summary.text}</p>}
        {r.experience.map((e) => (
          <section key={e.heading}>
            <h4 style={{ marginBottom: 4 }}>{e.heading}</h4>
            <ul>
              {e.bullets.map((b) => {
                const p = prov.get(b.id);
                return (
                  <li key={b.id} style={{ marginBottom: 8 }}>
                    {b.text}
                    <div>
                      <span className="badge">
                        {TRANSFORM[b.transformation] ?? b.transformation}
                      </span>
                      <span className="badge">checked ✓</span>
                      {b.verifier.review === "pass" && (
                        <span className="badge">independently reviewed ✓</span>
                      )}
                    </div>
                    {p && p.diff && <Diff parts={p.diff} />}
                    {p && !p.diff && p.sources.length > 1 && (
                      <p className="hint">From: {p.sources.map((s) => s.claim).join(" + ")}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {(["skills", "projects", "education", "certifications", "languages"] as const).map((k) =>
          r[k].length ? (
            <section key={k}>
              <h4 style={{ marginBottom: 4, textTransform: "capitalize" }}>{k}</h4>
              <p>{r[k].map((x) => x.text).join(" · ")}</p>
            </section>
          ) : null,
        )}
      </article>

      {r.dropped.length > 0 && (
        <>
          <h2>Removed by verification</h2>
          <p className="hint">
            These generated lines were not fully supported by your facts, even after one revision,
            so they were left out.
          </p>
          <ul>
            {r.dropped.map((x) => (
              <li key={x.text}>
                <s>{x.text}</s>
                <p className="hint">{x.reason}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.omitted.length > 0 && (
        <>
          <h2>Facts not included</h2>
          <p className="hint">Left out for length or relevance. Your fact bank is unchanged.</p>
          <ul>
            {d.omitted.map((o) => (
              <li key={o.id}>{o.claim ?? "(fact no longer active)"}</li>
            ))}
          </ul>
        </>
      )}
      <h2>Rendering checks</h2>
      <ul>
        {d.checks.map((c) => (
          <li key={c.name}>
            {c.ok ? "✓" : "✗"} {c.detail}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ResumeReviewPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Review />
    </Suspense>
  );
}
