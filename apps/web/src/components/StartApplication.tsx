"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/api";

export function StartApplication({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  return (
    <div className="actions">
      <button
        type="button"
        className="primary"
        onClick={() => {
          void api<{ application: { id: string } }>("POST", "/api/v1/applications", { jobId })
            .then((r) => {
              router.push(`/applications/detail?id=${r.application.id}`);
            })
            .catch((e: unknown) => {
              setMsg(errorText(e));
            });
        }}
      >
        Start an application
      </button>
      <span className="status error" role="status">
        {msg}
      </span>
    </div>
  );
}
