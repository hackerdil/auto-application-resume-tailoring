import { sha256Hex } from "@career-agent/security";
import type { FieldType, SubmitControlIdentity } from "@career-agent/domain";
import { classifyControl } from "../controls.js";
import { fingerprint, type PageSnapshot, type SnapshotElement } from "../snapshot.js";

export type AdapterId = "greenhouse" | "lever" | "ashby" | "generic";

/** A question read from the application form, ready to become an application field (origin "page"). */
export interface PageField {
  /** Stable across sessions: derived from the page key, control name, and label. */
  fieldKey: string;
  label: string;
  /** The control's name attribute (tells unlabelled questions apart). */
  name: string;
  type: FieldType;
  required: boolean;
  options: string[];
  /** Which form step the field was read on. */
  pageKey: string;
  /** No usable label: the owner must say what it asks before anything is filled. */
  ambiguous: boolean;
  /** Handles in the snapshot the field was read from (one per radio option). */
  handles: string[];
  /** Passwords, one-time codes and similar: listed for the owner, never stored or filled. */
  secret: boolean;
}

/**
 * Per-ATS knowledge (spec §13): how to recognise the form, read its questions, move between steps, which write
 * endpoints count as submission while preparing, and (for the Phase 8 submission service) where the final
 * submit control is and what a confirmation looks like. Adapters only read snapshots; they never act on pages.
 */
export interface AtsAdapter {
  id: AdapterId;
  detect(url: URL, atsMarker: string): boolean;
  /** Non-GET requests matching these are blocked while preparing. */
  blockedWritePatterns: readonly RegExp[];
  pageKey(s: PageSnapshot): string;
  extractFields(s: PageSnapshot): PageField[];
  /** The in-form "Next"/"Continue" control for multi-step forms, if any. */
  nextControl(s: PageSnapshot): SnapshotElement | null;
  /** The final submit control (Phase 8 submission service only; never exposed to preparation tools). */
  submitControl(s: PageSnapshot): SnapshotElement | null;
  /** Conservative success predicate; Phase 8 confirms with more evidence (spec §14). */
  isConfirmation(s: PageSnapshot): boolean;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+\.localhost)$/;
/** Fixture forms post to /submit; real endpoints are listed per adapter. */
const FIXTURE_SUBMIT =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?\/submit(\/|\?|$)/;
const NEXT_CAPTION = /^(next|next step|continue|save and continue|save & continue|proceed)$/i;
const CONFIRMATION =
  /\b(thank you for (applying|your application)|application (has been )?(received|submitted)|we('ve| have) received your application)\b/i;

const caption = (e: SnapshotElement) => (e.text || e.label || e.value).replace(/\s+/g, " ").trim();

function fieldType(e: SnapshotElement): FieldType {
  if (e.tag === "select") return "select";
  if (e.tag === "textarea") return "textarea";
  if (e.role === "combobox") return "text";
  const map: Record<string, FieldType> = {
    text: "text",
    search: "text",
    email: "email",
    tel: "tel",
    url: "url",
    number: "number",
    date: "date",
    month: "date",
    radio: "radio",
    checkbox: "checkbox",
    file: "file",
    password: "text",
  };
  return map[e.type] ?? "unknown";
}

function defaultPageKey(s: PageSnapshot): string {
  const path = new URL(s.url).pathname;
  // Multi-step forms change the visible step heading, not the URL.
  const step = s.headings.find((h) => /\bstep\b|\bpage \d/i.test(h)) ?? "";
  return `${path}${step ? `#${step.toLowerCase().replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

/** Shared extraction: one field per input, one per radio group; buttons and links are not questions. */
function extract(s: PageSnapshot, pageKey: string): PageField[] {
  const out: PageField[] = [];
  const radios = new Map<string, PageField>();
  for (const e of s.elements) {
    if (classifyControl(e) !== "field") continue;
    const type = fieldType(e);
    if (type === "radio") {
      const key = `${e.frame}|${e.name || e.groupLabel}`;
      const existing = radios.get(key);
      if (existing) {
        existing.options.push(e.label);
        existing.handles.push(e.handle);
        existing.required ||= e.required;
        continue;
      }
      const label = e.groupLabel.trim();
      const f: PageField = {
        fieldKey: "",
        label: label || e.name,
        name: e.name,
        type,
        required: e.required,
        options: [e.label],
        pageKey,
        ambiguous: label.length < 3,
        handles: [e.handle],
        secret: false,
      };
      radios.set(key, f);
      out.push(f);
      continue;
    }
    const label = (e.label || e.placeholder).trim();
    out.push({
      fieldKey: "",
      label: label || e.name || "(unlabelled field)",
      name: e.name,
      type,
      required: e.required,
      options:
        e.tag === "select"
          ? e.options.filter((o) => !/^(select|choose|please select)\b.*$|^-+$|^$/i.test(o.trim()))
          : [],
      pageKey,
      // A question without a real label (e.g. "Yes/No?" next to a box) cannot be matched to an answer safely.
      ambiguous: label.length < 3 || /^(yes\/no\??|\?|other)$/i.test(label),
      handles: [e.handle],
      secret: e.secret,
    });
  }
  for (const f of out) {
    const first = s.elements.find((e) => e.handle === f.handles[0]);
    f.fieldKey = `page:${sha256Hex(`${pageKey}|${first?.frame ?? ""}|${first?.name ?? ""}|${first?.id ?? ""}|${f.label}`).slice(0, 24)}`;
  }
  return out;
}

function nextControl(s: PageSnapshot): SnapshotElement | null {
  return (
    s.elements.find(
      (e) =>
        !e.disabled && classifyControl(e) === "safe_navigation" && NEXT_CAPTION.test(caption(e)),
    ) ?? null
  );
}

function submitBy(re: RegExp) {
  return (s: PageSnapshot): SnapshotElement | null => {
    const hits = s.elements.filter(
      (e) => e.inForm && !e.disabled && classifyControl(e) === "submit" && re.test(caption(e)),
    );
    return hits.length === 1 ? (hits[0] ?? null) : null;
  };
}

const isConfirmation = (s: PageSnapshot) =>
  [s.title, ...s.headings].some((t) => CONFIRMATION.test(t));

const fixture = (marker: string, id: AdapterId, url: URL) =>
  LOOPBACK.test(url.hostname) && marker === id;

function adapter(
  id: Exclude<AdapterId, "generic">,
  hosts: RegExp,
  writes: RegExp[],
  submitCaption: RegExp,
): AtsAdapter {
  return {
    id,
    detect: (url, marker) =>
      (url.protocol === "https:" && hosts.test(url.hostname)) || fixture(marker, id, url),
    blockedWritePatterns: [...writes, FIXTURE_SUBMIT],
    pageKey: defaultPageKey,
    extractFields: (s) => extract(s, defaultPageKey(s)),
    nextControl,
    submitControl: submitBy(submitCaption),
    isConfirmation,
  };
}

export const greenhouseAdapter = adapter(
  "greenhouse",
  /^(boards|job-boards)(\.eu)?\.greenhouse\.io$/,
  [
    /^https:\/\/[^/]*greenhouse\.io\/.*\/applications?(\/|\?|$)/i,
    /^https:\/\/[^/]*greenhouse\.io\/.*\/(submit|apply)(\/|\?|$)/i,
  ],
  /^submit( application)?$/i,
);

export const leverAdapter = adapter(
  "lever",
  /^jobs(\.eu)?\.lever\.co$/,
  [/^https:\/\/jobs(\.eu)?\.lever\.co\/.*\/apply(\/|\?|$)/i],
  /^submit( application)?$/i,
);

export const ashbyAdapter = adapter(
  "ashby",
  /^jobs\.ashbyhq\.com$/,
  [
    /^https:\/\/jobs\.ashbyhq\.com\/api\/.*submit/i,
    /^https:\/\/jobs\.ashbyhq\.com\/.*\/application\/?(\?|$)/i,
  ],
  /^submit( application)?$/i,
);

/**
 * Unknown sites: every non-GET request is blocked while preparing (some forms upload or autosave via XHR, which
 * then simply fails and is reported), and no submit control is located unless exactly one obvious one exists.
 */
export const genericAdapter: AtsAdapter = {
  id: "generic",
  detect: () => true,
  blockedWritePatterns: [/.*/],
  pageKey: defaultPageKey,
  extractFields: (s) => extract(s, defaultPageKey(s)),
  nextControl,
  submitControl: submitBy(/^(submit|submit application|apply|send application)$/i),
  isConfirmation,
};

export const ADAPTERS: readonly AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  genericAdapter,
];

export function adapterFor(url: string, atsMarker = ""): AtsAdapter {
  const u = new URL(url);
  return ADAPTERS.find((a) => a.detect(u, atsMarker)) ?? genericAdapter;
}

export function adapterById(id: string): AtsAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}

/** Identity of a submit control as stored in an approval binding (computing it never clicks anything). */
export function submitControlIdentity(
  adapter: AtsAdapter,
  e: SnapshotElement,
): SubmitControlIdentity {
  return {
    adapter: adapter.id,
    selectorFingerprint: fingerprint(e),
    accessibleName: (e.text || e.label || e.value).replace(/\s+/g, " ").trim().slice(0, 120),
    frameUrl: e.frame,
  };
}
