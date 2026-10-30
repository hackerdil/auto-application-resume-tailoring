"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorText, type ResumeSummary } from "@/lib/api";

const STATUS: Record<ResumeSummary["status"], string> = {
  draft: "ready for your review",
  needs_attention: "needs attention",
  approved: "approved",
  rejected: "rejected",
};

/** Résumé versions for one job, with a button to tailor a new one. */
export function ResumePanel({ jobId }: { jobId: string }) {
  const [list, setList] = useState<ResumeSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState<"one-page" | "full">("one-page");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ resumes: ResumeSummary[]; tailoring: boolean }>(
      "GET",
      `/api/v1/tailored-resumes?jobId=${encodeURIComponent(jobId)}`,
    );
    setList(r.resumes);
    setBusy(r.tailoring);
  }, [jobId]);

  useEffect(() => {
    load().catch((e: unknown) => {
      setMsg(errorText(e));
    });
  }, [load]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 2500);
    return () => {
      clearInterval(t);
    };
  }, [busy, load]);

  return (
    <section aria-labelledby="resume-h">
      <h2 id="resume-h">Tailored résumé</h2>
      <p className="hint">
        Built only from your verified facts. Every line is checked against the facts it cites before
        you see it, and nothing is sent anywhere until you approve it in an application.
      </p>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: "0 0 auto" }}>
          <label htmlFor="resume-length">Length</label>
          <select
            id="resume-length"
            value={length}
            onChange={(e) => {
              setLength(e.target.value === "full" ? "full" : "one-page");
            }}
          >
            <option value="one-page">One page</option>
            <option value="full">Full</option>
          </select>
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              void api("POST", "/api/v1/tailored-resumes", { jobId, length })
                .then(() => {
                  setMsg("Tailoring started.");
                  return load();
                })
                .catch((e: unknown) => {
                  setMsg(errorText(e));
                });
            }}
          >
            {busy ? "Tailoring…" : "Tailor a résumé"}
          </button>
        </div>
      </div>
      <p className="status" role="status" aria-live="polite">
        {msg}
      </p>
      {list.length === 0 ? (
        <p className="empty">No tailored résumé yet.</p>
      ) : (
        <ul>
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/resumes/detail?id=${r.id}`}>
                {new Date(r.createdAt).toLocaleString()} · {r.length} · {STATUS[r.status]}
              </Link>
              <span className="hint">
                {" "}
                · {r.bullets} bullet(s)
                {r.dropped ? `, ${r.dropped} claim(s) removed by verification` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
