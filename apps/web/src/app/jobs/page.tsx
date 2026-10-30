"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, fmtComp, fmtDate, type JobSummary } from "@/lib/api";

const VIEWS = {
  eligible: { label: "Eligible", statuses: "ELIGIBLE,SCORED" },
  shortlisted: { label: "Shortlisted", statuses: "SHORTLISTED" },
  filtered: { label: "Filtered out", statuses: "FILTERED" },
  skipped: { label: "Skipped & archived", statuses: "SKIPPED,ARCHIVED" },
  all: { label: "All", statuses: "" },
} as const;
type View = keyof typeof VIEWS;
const PAGE = 25;

function JobInbox() {
  const params = useSearchParams();
  const router = useRouter();
  const view: View = (params.get("view") as View | null) ?? "eligible";
  const q = params.get("q") ?? "";
  const sourceId = params.get("sourceId") ?? "";
  const page = Number(params.get("page") ?? "0");
  const sort = params.get("sort") === "score" ? "score" : "recent";
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState(q);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [url, setUrl] = useState("");
  const [generic, setGeneric] = useState(false);

  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`/jobs?${next.toString()}`);
  };

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), sort });
    if (VIEWS[view].statuses) qs.set("status", VIEWS[view].statuses);
    if (q) qs.set("q", q);
    if (sourceId) qs.set("sourceId", sourceId);
    const r = await api<{ total: number; jobs: JobSummary[] }>(
      "GET",
      `/api/v1/jobs?${qs.toString()}`,
    );
    setJobs(r.jobs);
    setTotal(r.total);
  }, [view, q, sourceId, page, sort]);

  useEffect(() => {
    load().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [load]);

  async function importUrl(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const r = await api<{ job: JobSummary; created: boolean }>("POST", "/api/v1/jobs/import", {
        url,
        allowGenericReader: generic,
      });
      setStatus({
        kind: "ok",
        text: r.created
          ? `Imported "${r.job.title}" (${r.job.status === "FILTERED" ? "filtered out" : "eligible"}).`
          : `"${r.job.title}" was already known; refreshed it.`,
      });
      setUrl("");
      await load();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  }

  return (
    <>
      <h1>Job inbox</h1>
      <p className="lede">
        Jobs found on your sources and URLs you imported. Match scores are an internal relevance
        heuristic based on your verified facts, not an employer ATS score.
      </p>
      <Status state={status} />

      <nav aria-label="Job views" className="actions">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <button
            key={v}
            type="button"
            className={v === view ? "primary" : ""}
            aria-pressed={v === view}
            onClick={() => {
              setParam({ view: v, page: "" });
            }}
          >
            {VIEWS[v].label}
          </button>
        ))}
      </nav>
      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setParam({ q: search, page: "" });
        }}
        role="search"
      >
        <div>
          <label htmlFor="q">Search title or company</label>
          <input
            id="q"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <button type="submit">Search</button>
        </div>
      </form>
      {sourceId && (
        <p className="hint">
          Showing one source.{" "}
          <button
            type="button"
            onClick={() => {
              setParam({ sourceId: "" });
            }}
          >
            Show all sources
          </button>
        </p>
      )}

      <div className="row" style={{ alignItems: "center" }}>
        <p className="hint">
          {total} job{total === 1 ? "" : "s"}
        </p>
        <div style={{ flex: "0 0 auto" }}>
          <label htmlFor="sort" className="hint">
            Sort
          </label>
          <select
            id="sort"
            value={sort}
            onChange={(e) => {
              setParam({ sort: e.target.value === "score" ? "score" : "", page: "" });
            }}
          >
            <option value="recent">Newest first</option>
            <option value="score">Highest match first</option>
          </select>
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <button
            type="button"
            onClick={() => {
              void api<{ queued: string[] }>("POST", "/api/v1/jobs/score", {})
                .then((r) => {
                  setStatus({
                    kind: "ok",
                    text: `Scoring ${r.queued.length} job(s) in the background. Refresh in a moment.`,
                  });
                })
                .catch((e: unknown) => {
                  setStatus({ kind: "error", text: errorText(e) });
                });
            }}
          >
            Score eligible jobs
          </button>
        </div>
      </div>
      {jobs.length === 0 && (
        <p className="empty">
          No jobs here yet. Add sources and run discovery, or import a job URL below.
        </p>
      )}
      {jobs.map((j) => (
        <article className="card" key={j.id}>
          <div>
            {j.match && (
              <span
                className={`badge ${j.match.verdict === "disqualified" ? "sensitive" : ""}`}
                title="Internal relevance heuristic, not an ATS score"
              >
                match {j.match.total} · {j.match.verdict}
                {j.match.stale ? " · outdated" : ""}
              </span>
            )}
            <span className="badge">{j.status.toLowerCase()}</span>
            <span className="badge">
              {j.workMode === "unknown" ? "work mode unknown" : j.workMode}
            </span>
            {j.removedFromSourceAt && <span className="badge sensitive">no longer listed</span>}
          </div>
          <h3 style={{ margin: "8px 0 4px" }}>
            <Link href={`/jobs/detail?id=${encodeURIComponent(j.id)}`}>{j.title}</Link>
          </h3>
          <p style={{ margin: 0 }}>
            {j.company} · {j.locations.join("; ") || "location unknown"} · posted{" "}
            {fmtDate(j.postedAt)}
            {fmtComp(j.compensation) ? ` · ${fmtComp(j.compensation) ?? ""}` : ""}
          </p>
          {j.filterReasons.length > 0 && (
            <ul className="hint" aria-label="Why this job was filtered">
              {j.filterReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
      <div className="actions">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => {
            setParam({ page: String(page - 1) });
          }}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={(page + 1) * PAGE >= total}
          onClick={() => {
            setParam({ page: String(page + 1) });
          }}
        >
          Next
        </button>
      </div>

      <h2>Import a job URL</h2>
      <form className="card" onSubmit={(e) => void importUrl(e)}>
        <label htmlFor="import-url">
          Posting URL <span className="hint">Greenhouse, Lever, or Ashby links work best</span>
        </label>
        <input
          id="import-url"
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
          required
          placeholder="https://jobs.lever.co/company/…"
        />
        <label className="check" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={generic}
            onChange={(e) => {
              setGeneric(e.target.checked);
            }}
          />
          Allow the generic career-page reader (reads only structured job data on other sites)
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            Import
          </button>
        </div>
      </form>
    </>
  );
}

export default function JobsPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <JobInbox />
    </Suspense>
  );
}
