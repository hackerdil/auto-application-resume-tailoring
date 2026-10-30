"use client";

export type StatusState = { kind: "idle" } | { kind: "ok" | "error"; text: string };

/** Polite live region so screen readers hear the result of each action. */
export function Status({ state }: { state: StatusState }) {
  return (
    <p
      className={`status ${state.kind === "idle" ? "" : state.kind}`}
      role="status"
      aria-live="polite"
    >
      {state.kind === "idle" ? "" : state.text}
    </p>
  );
}
