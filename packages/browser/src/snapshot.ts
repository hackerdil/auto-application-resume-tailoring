import type { ElementHandle, Frame, Page } from "playwright";
import { randomBytes } from "node:crypto";
import { canonicalJson, hmacSha256Hex, sha256Hex } from "@career-agent/security";

/** Per-process key: secret values are never stored or shown, but a change to one still changes the form hash. */
const SECRET_DIGEST_KEY = randomBytes(32);
import { COLLECTOR } from "./collector.js";

export interface RawItem {
  tag: string;
  type: string;
  role: string;
  name: string;
  id: string;
  label: string;
  groupLabel: string;
  placeholder: string;
  required: boolean;
  value: string;
  checked: boolean;
  options: string[];
  disabled: boolean;
  visible: boolean;
  inForm: boolean;
  formAction: string;
  formMethod: string;
  text: string;
  href: string;
  invalid: boolean;
  errorText: string;
  autocomplete: string;
  ariaAutocomplete: string;
  accept: string;
  multiple: boolean;
  shadow: boolean;
}

export interface SnapshotElement extends Omit<RawItem, "value"> {
  handle: string;
  frame: string;
  /** Redacted for secrets (passwords, one-time codes, card/ID numbers). */
  value: string;
  secret: boolean;
  /** For secrets: a keyed digest (per process) so a changed value still changes the form hash. */
  secretDigest: string;
}

export interface PageSnapshot {
  generation: number;
  url: string;
  origin: string;
  title: string;
  headings: string[];
  elements: SnapshotElement[];
  frames: { url: string; origin: string; interactive: boolean }[];
  signals: { passwordField: boolean; captcha: boolean; atsMarker: string };
}

const SECRET_LABEL =
  /\b(password|passcode|pass code|one[- ]?time|otp|verification code|security code|2fa|mfa|authenticator|ssn|social security|cvv|cvc|card number|iban|token|api[- ]?key|access key|secret|pin|recovery code|backup code|passport|licen[cs]e number|tax id)\b/i;
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-number|cc-csc)$/i;

export function isSecretField(
  i: Pick<RawItem, "type" | "label" | "name" | "autocomplete" | "placeholder">,
): boolean {
  return (
    i.type === "password" ||
    SECRET_AUTOCOMPLETE.test(i.autocomplete) ||
    SECRET_LABEL.test(`${i.label} ${i.name} ${i.placeholder}`)
  );
}

export interface TakenSnapshot {
  snapshot: PageSnapshot;
  handles: Map<string, { handle: ElementHandle; fingerprint: string }>;
}

export const fingerprint = (
  i: Pick<RawItem, "tag" | "type" | "name" | "id" | "label" | "options" | "text">,
): string =>
  sha256Hex(
    canonicalJson({ t: i.tag, y: i.type, n: i.name, i: i.id, l: i.label, o: i.options, x: i.text }),
  ).slice(0, 16);

/**
 * Structured, numbered view of the page (spec §13): interactive elements from the main frame and allowed
 * frames (including open shadow roots), with labels, required/validation state, options, and current values.
 * Handles are scoped to this generation; a new snapshot or a navigation invalidates them.
 */
export async function takeSnapshot(
  page: Page,
  generation: number,
  interactiveOrigins: ReadonlySet<string>,
): Promise<TakenSnapshot> {
  const handles = new Map<string, { handle: ElementHandle; fingerprint: string }>();
  const elements: SnapshotElement[] = [];
  const frames: PageSnapshot["frames"] = [];
  let main: { headings: string[]; title: string; signals: PageSnapshot["signals"] } = {
    headings: [],
    title: "",
    signals: { passwordField: false, captcha: false, atsMarker: "" },
  };
  let n = 0;
  for (const frame of page.frames()) {
    const origin = safeOrigin(frame);
    const interactive = interactiveOrigins.has(origin);
    frames.push({ url: frame.url().split("?")[0] ?? "", origin, interactive });
    if (!interactive) continue;
    const result = await frame.evaluateHandle(COLLECTOR).catch(() => null);
    if (!result) continue;
    const data = (await result.evaluate(
      (r: { items: unknown; headings: unknown; title: unknown; signals: unknown }) => ({
        items: r.items,
        headings: r.headings,
        title: r.title,
        signals: r.signals,
      }),
    )) as {
      items: RawItem[];
      headings: string[];
      title: string;
      signals: PageSnapshot["signals"];
    };
    const elsHandle = await result.getProperty("els");
    const props = await elsHandle.getProperties();
    const frameLabel = frame === page.mainFrame() ? "main" : `frame:${origin}`;
    if (frame === page.mainFrame())
      main = { headings: data.headings, title: data.title, signals: data.signals };
    else if (data.signals.passwordField || data.signals.captcha)
      main.signals = {
        ...main.signals,
        passwordField: main.signals.passwordField || data.signals.passwordField,
        captcha: main.signals.captcha || data.signals.captcha,
      };
    data.items.forEach((item, idx) => {
      const el = props.get(String(idx))?.asElement();
      if (!el) return;
      const handle = `${generation}.${++n}`;
      const secret = isSecretField(item);
      handles.set(handle, { handle: el, fingerprint: fingerprint(item) });
      elements.push({
        ...item,
        handle,
        frame: frameLabel,
        secret,
        secretDigest: secret && item.value ? hmacSha256Hex(SECRET_DIGEST_KEY, item.value) : "",
        // Full values: the form hash must bind every character the owner approved (model views truncate).
        value: secret && item.value ? "[REDACTED]" : item.value,
      });
    });
  }
  const url = page.url();
  return {
    snapshot: {
      generation,
      url,
      origin: new URL(url).origin,
      title: main.title.slice(0, 200),
      headings: main.headings,
      elements,
      frames,
      signals: main.signals,
    },
    handles,
  };
}

function safeOrigin(frame: Frame): string {
  try {
    return new URL(frame.url()).origin;
  } catch {
    return "null";
  }
}

/**
 * Hash of the form's material state (Phase 8 approval binding): field identities, labels, types, required flags,
 * options, and values — excluding handles and other volatile data.
 */
export function snapshotHash(s: PageSnapshot): string {
  return sha256Hex(
    canonicalJson({
      origin: s.origin,
      path: new URL(s.url).pathname,
      fields: s.elements
        .filter((e) => e.tag !== "a")
        .map((e) => ({
          f: e.frame,
          t: e.tag,
          y: e.type,
          n: e.name,
          i: e.id,
          l: e.label,
          g: e.groupLabel,
          r: e.required,
          o: e.options,
          v: e.value,
          s: e.secretDigest,
          a: e.formAction,
          m: e.formMethod,
          c: e.checked,
          x: e.text,
          d: e.disabled,
        })),
    }),
  );
}
