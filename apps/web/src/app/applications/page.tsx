"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, STATE_TEXT } from "@/lib/api";

interface Row {
  id: string;
  state: string;
  updatedAt: string;
  job: { title: string; company: string } | null;
  pending: number;
  answersComplete: boolean;
}

export default function ApplicationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });
  useEffect(() => {
    api<{ applications: Row[] }>("GET", "/api/v1/applications")
      .then((r) => {
        setRows(r.applications);
      })
      .catch((e: unknown) => {
        setStatus({ kind: "error", text: errorText(e) });
      });
  }, []);
  return (
    <>
      <h1>Applications</h1>
      <p className="lede">
        Prepare materials and answers for one job at a time. Nothing is sent to an employer from
        here.
      </p>
      <Status state={status} />
      {rows.length === 0 && (
        <p className="empty">
          No applications yet. Open a scored job and choose “Start an application”.
        </p>
      )}
      {rows.map((r) => (
        <article className="card" key={r.id}>
          <span className="badge">{STATE_TEXT[r.state] ?? r.state.toLowerCase()}</span>
          {r.pending > 0 && (
            <span className="badge sensitive">{r.pending} question(s) need you</span>
          )}
          <h3 style={{ margin: "8px 0 4px" }}>
            <Link href={`/applications/detail?id=${r.id}`}>
              {r.job ? `${r.job.title} · ${r.job.company}` : "Job"}
            </Link>
          </h3>
          <p className="hint">Updated {new Date(r.updatedAt).toLocaleString()}</p>
        </article>
      ))}
    </>
  );
}
