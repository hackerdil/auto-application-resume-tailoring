"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { MatchPanel } from "@/components/MatchPanel";
import { ResumePanel } from "@/components/ResumePanel";
import { StartApplication } from "@/components/StartApplication";
import { api, errorText, fmtComp, fmtDate, type JobDetail, type MatchResponse } from "@/lib/api";

const ACTIONS: Record<string, { to: "SHORTLISTED" | "SKIPPED" | "ARCHIVED"; label: string }[]> = {
  SCORED: [
    { to: "SHORTLISTED", label: "Shortlist" },
    { to: "SKIPPED", label: "Skip" },
  ],
  SHORTLISTED: [{ to: "ARCHIVED", label: "Archive" }],
  SKIPPED: [{ to: "ARCHIVED", label: "Archive" }],
  FILTERED: [{ to: "ARCHIVED", label: "Archive" }],
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="hint">{label}</dt>
      <dd style={{ margin: "0 0 8px" }}>{children}</dd>
    </div>
  );
}

function Detail() {
  const id = useSearchParams().get("id") ?? "";
  const [job, setJob] = useState<JobDetail | null>(null);
  const [match, setMatch] = useState<MatchResponse | null>(null);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  const load = useCallback(async () => {
    const [j, m] = await Promise.all([
      api<{ job: JobDetail }>("GET", `/api/v1/jobs/detail?id=${encodeURIComponent(id)}`),
      api<MatchResponse>("GET", `/api/v1/jobs/match?id=${encodeURIComponent(id)}`),
    ]);
    setJob(j.job);
    setMatch(m);
  }, [id]);

  // Poll while the worker is scoring this job.
  useEffect(() => {
    if (!match?.scoring) return;
    const t = setInterval(() => {
      void load().catch(() => undefined);
    }, 2000);
    return () => {
      clearInterval(t);
    };
  }, [match?.scoring, load]);

  useEffect(() => {
    load().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [load]);

  if (!job) return <Status state={status} />;
  const comp = fmtComp(job.compensation);
  return (
    <>
      <p>
        <Link href="/jobs">← Back to inbox</Link>
      </p>
      <h1>{job.title}</h1>
      <p className="lede">
        {job.company}
        {job.team ? ` · ${job.team}` : ""}
      </p>
      <Status state={status} />
      {job.removedFromSourceAt && (
        <p className="notice">
          This posting was no longer listed on its job board on {fmtDate(job.removedFromSourceAt)}.
          It may be closed.
        </p>
      )}

      {job.filterReasons.length > 0 && (
        <div className="notice" role="note">
          <strong>Filtered out by your preferences:</strong>
          <ul>
            {job.filterReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="card row">
        <Fact label="Status">{job.status.toLowerCase()}</Fact>
        <Fact label="Location">{job.locations.join("; ") || "unknown"}</Fact>
        <Fact label="Work mode">{job.workMode}</Fact>
        <Fact label="Employment">{job.employmentType.replace("_", " ")}</Fact>
        <Fact label="Seniority (from title)">{job.seniority}</Fact>
        <Fact label="Compensation">{comp ?? "not stated"}</Fact>
        <Fact label="Visa sponsorship">
          {job.sponsorship.value === "unknown"
            ? "not stated"
            : job.sponsorship.value.replace("_", " ")}
          {job.sponsorship.evidence && <blockquote>{job.sponsorship.evidence}</blockquote>}
        </Fact>
        <Fact label="Posted">{fmtDate(job.postedAt)}</Fact>
        <Fact label="First / last seen">
          {fmtDate(job.firstSeenAt)} / {fmtDate(job.lastSeenAt)}
        </Fact>
        <Fact label="Source">
          <a href={job.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
            {job.source} posting ↗
          </a>
        </Fact>
      </dl>

      <div className="actions">
        {(ACTIONS[job.status] ?? []).map((a) => (
          <button
            key={a.to}
            type="button"
            onClick={() => {
              void api("POST", "/api/v1/jobs/status", { id: job.id, to: a.to })
                .then(() => {
                  setStatus({ kind: "ok", text: `Marked as ${a.to.toLowerCase()}.` });
                  return load();
                })
                .catch((e: unknown) => {
                  setStatus({ kind: "error", text: errorText(e) });
                });
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {["ELIGIBLE", "SCORED", "SHORTLISTED", "SKIPPED"].includes(job.status) && (
        <div className="actions">
          <button
            type="button"
            disabled={match?.scoring}
            onClick={() => {
              void api("POST", "/api/v1/jobs/score", { ids: [job.id] })
                .then(() => {
                  setStatus({ kind: "ok", text: "Scoring queued." });
                  return load();
                })
                .catch((e: unknown) => {
                  setStatus({ kind: "error", text: errorText(e) });
                });
            }}
          >
            {match?.match ? "Re-score" : "Score this job"}
          </button>
        </div>
      )}
      {match && <MatchPanel data={match} />}
      {["ELIGIBLE", "SCORED", "SHORTLISTED"].includes(job.status) && <ResumePanel jobId={job.id} />}
      {["ELIGIBLE", "SCORED", "SHORTLISTED"].includes(job.status) && (
        <StartApplication jobId={job.id} />
      )}

      <div className="row">
        <section>
          <h2>Listed requirements</h2>
          {job.requiredQualifications.length ? (
            <ul>
              {job.requiredQualifications.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className="empty">None listed in a recognizable section.</p>
          )}
        </section>
        <section>
          <h2>Listed nice-to-haves</h2>
          {job.preferredQualifications.length ? (
            <ul>
              {job.preferredQualifications.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className="empty">None listed.</p>
          )}
        </section>
      </div>

      <h2>Description</h2>
      <p className="hint">
        Text from the employer&apos;s posting, sanitized. It is treated as information only, never
        as instructions.
      </p>
      {job.descriptionHtmlSanitized ? (
        // Sanitized server-side with an allowlist (no scripts, styles, event handlers, or unsafe links).
        <div className="card" dangerouslySetInnerHTML={{ __html: job.descriptionHtmlSanitized }} />
      ) : (
        <div className="card" style={{ whiteSpace: "pre-wrap" }}>
          {job.descriptionText}
        </div>
      )}
    </>
  );
}

export default function JobDetailPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Detail />
    </Suspense>
  );
}
