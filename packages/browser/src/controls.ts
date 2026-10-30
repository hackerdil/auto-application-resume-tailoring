import type { SnapshotElement } from "./snapshot.js";

export type ControlKind = "field" | "submit" | "safe_navigation" | "option" | "link" | "unknown";

/** Words that mean "send / finalize / agree": such controls are never clickable by preparation code or models. */
const SUBMIT_WORDS =
  /\b(submit|apply|send|finish|finali[sz]e|complete|confirm|done|place|sign|agree|accept|register|create account|pay|purchase|book|schedule|withdraw|delete|remove application)\b/i;
/** Exact labels of controls that move within a form without sending it. */
const NAVIGATION_LABELS =
  /^(next|next step|continue|save and continue|save & continue|proceed|back|previous|add another|add more|add|upload|upload file|attach|attach file|browse|choose file|select file|expand|show more|show details|edit|enter manually)$/i;

const FIELD_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "search",
  "date",
  "month",
  "password",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "file",
]);

/**
 * Deterministic control classification (ADR-007, spec §13). Anything that could send, agree to, or finalize an
 * application is "submit" and refused by every tool; only exact, known navigation labels are clickable.
 */
export function classifyControl(
  e: Pick<SnapshotElement, "tag" | "type" | "role" | "text" | "label" | "value">,
): ControlKind {
  if ((e.tag === "input" || e.tag === "select" || e.tag === "textarea") && FIELD_TYPES.has(e.type))
    return "field";
  if (e.role === "combobox") return "field";
  const caption = (e.text || e.label || e.value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[›»→…]+$/, "")
    .trim();
  // Checked before roles: an "option" or link that says "Submit application" is still a submit control.
  if (SUBMIT_WORDS.test(caption)) return "submit";
  if (e.tag === "a") return "link";
  if (e.role === "option") return "option";
  if (e.type === "image") return "submit";
  if (NAVIGATION_LABELS.test(caption)) return "safe_navigation";
  if (e.type === "submit" || e.type === "reset") return "submit";
  return "unknown";
}
