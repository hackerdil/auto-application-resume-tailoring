"use client";

import { useEffect, useState } from "react";

/** Says plainly when this is the fictional demo, or a mode in which nothing can be submitted. */
export function ModeBanner() {
  const [state, setState] = useState<{ demo: boolean; mode: string } | null>(null);
  useEffect(() => {
    fetch("/api/v1/ready")
      .then((r) => r.json() as Promise<{ demo?: boolean; mode?: string }>)
      .then((r) => {
        setState({ demo: r.demo === true, mode: r.mode ?? "review-each" });
      })
      .catch(() => undefined);
  }, []);
  if (!state) return null;
  if (state.demo)
    return (
      <p className="banner" role="note">
        Demo mode: all people, companies, and jobs here are fictional, forms open only on this
        machine, no AI service is contacted, and nothing can be submitted.
      </p>
    );
  if (state.mode !== "review-each")
    return (
      <p className="banner" role="note">
        Operating mode “{state.mode}”: applications cannot be approved or submitted.
      </p>
    );
  return null;
}
