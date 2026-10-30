"use client";

import { useCallback, useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, fmtDate, type DiscoveryTask, type JobSource } from "@/lib/api";

const TYPES = [
  { value: "greenhouse", label: "Greenhouse", hint: "boards.greenhouse.io/<board>" },
  { value: "lever", label: "Lever", hint: "jobs.lever.co/<site> (EU: eu/<site>)" },
  { value: "ashby", label: "Ashby", hint: "jobs.ashbyhq.com/<board>" },
] as const;

function lastFetchText(s: JobSource): string {
  const f = s.lastFetch;
  if (!f) return "Never fetched";
  const when = new Date(f.fetchedAt).toLocaleString();
  if (f.outcome === "error") return `Failed ${when}: ${f.errorMessage ?? "unknown error"}`;
  if (f.outcome === "not_modified") return `Checked ${when}: no changes`;
  return `Fetched ${when}: ${f.itemCount} job${f.itemCount === 1 ? "" : "s"}, ${f.newCount} new${f.skippedCount ? `, ${f.skippedCount} unreadable` : ""}`;
}

export default function SourcesPage() {
  const [sources, setSources] = useState<JobSource[]>([]);
  const [tasks, setTasks] = useState<DiscoveryTask[]>([]);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  const [type, setType] = useState<(typeof TYPES)[number]["value"]>("greenhouse");
  const [identifier, setIdentifier] = useState("");
  const [displayName, setDisplayName] = useState("");

  const refresh = useCallback(async () => {
    const [s, t] = await Promise.all([
      api<{ sources: JobSource[] }>("GET", "/api/v1/job-sources"),
      api<{ tasks: DiscoveryTask[] }>("GET", "/api/v1/discovery/tasks"),
    ]);
    setSources(s.sources);
    setTasks(t.tasks);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [refresh]);

  // Poll while discovery is running.
  useEffect(() => {
    if (!sources.some((s) => s.running)) return;
    const t = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3000);
    return () => {
      clearInterval(t);
    };
  }, [sources, refresh]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setStatus({ kind: "ok", text: ok });
      await refresh();
    } catch (err) {
      setStatus({ kind: "error", text: errorText(err) });
    }
  };

  const hint = TYPES.find((t) => t.value === type)?.hint ?? "";

  return (
    <>
      <h1>Job sources</h1>
      <p className="lede">
        Career Agent reads public job boards from Greenhouse, Lever, and Ashby. It never logs in to
        job sites and does not use LinkedIn or Indeed, whose terms prohibit automated access.
      </p>
      <Status state={status} />

      <div className="actions">
        <button
          className="primary"
          type="button"
          disabled={sources.every((s) => !s.enabled)}
          onClick={() =>
            void run(
              () => api("POST", "/api/v1/discovery", {}),
              "Discovery started. Results appear as each source finishes.",
            )
          }
        >
          Run discovery now
        </button>
      </div>

      <h2>Configured sources</h2>
      {sources.length === 0 && (
        <p className="empty">No sources yet. Add a company&apos;s job board below.</p>
      )}
      {sources.map((s) => (
        <div className="card" key={s.id}>
          <span className="badge">{s.type}</span>
          {!s.enabled && <span className="badge">disabled</span>}
          {s.running && <span className="badge">running…</span>}
          <p style={{ margin: "8px 0" }}>
            <strong>{s.displayName ?? s.identifier}</strong>{" "}
            <span className="hint">({s.identifier})</span>
          </p>
          <p className={`hint ${s.lastFetch?.outcome === "error" ? "status error" : ""}`}>
            {lastFetchText(s)}
          </p>
          <div className="actions">
            <a className="button" href={`/jobs?sourceId=${s.id}`}>
              View jobs
            </a>
            <button
              type="button"
              onClick={() =>
                void run(
                  () =>
                    api("POST", `/api/v1/job-sources/${s.id}/${s.enabled ? "disable" : "enable"}`),
                  s.enabled ? "Source disabled." : "Source enabled.",
                )
              }
            >
              {s.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      ))}

      <h2>Add a job board</h2>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              api("POST", "/api/v1/job-sources", {
                type,
                identifier,
                ...(displayName.trim() ? { displayName } : {}),
              }),
            "Source added.",
          ).then(() => {
            setIdentifier("");
            setDisplayName("");
          });
        }}
      >
        <div className="row">
          <div>
            <label htmlFor="src-type">Job board type</label>
            <select
              id="src-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as typeof type);
              }}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="src-id">
              Board name <span className="hint">from {hint}</span>
            </label>
            <input
              id="src-id"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
              }}
              required
            />
          </div>
          <div>
            <label htmlFor="src-name">
              Company name <span className="hint">optional</span>
            </label>
            <input
              id="src-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />
          </div>
        </div>
        <div className="actions">
          <button className="primary" type="submit">
            Add source
          </button>
        </div>
      </form>

      <h2>Recent discovery runs</h2>
      {tasks.length === 0 ? (
        <p className="empty">No runs yet.</p>
      ) : (
        <ul>
          {tasks.slice(0, 10).map((t) => {
            const src = sources.find((s) => s.id === t.sourceId);
            return (
              <li key={t.id}>
                {src?.displayName ?? src?.identifier ?? "source"}: {t.status}
                {t.attempts > 1 ? ` (attempt ${t.attempts})` : ""}
                {t.lastErrorClass ? `, last error ${t.lastErrorClass}` : ""} ·{" "}
                {fmtDate(t.updatedAt)}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
