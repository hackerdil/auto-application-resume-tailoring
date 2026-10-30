export const REDACTED = "[REDACTED]";

/** Object keys whose values are always redacted, at any depth. */
const SENSITIVE_KEY_RE =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|authori[sz]ation|cookie|otp|one[-_]?time|mfa|totp|session[-_]?(id|secret)?|credential|private[-_]?key|ssn|social[-_]?security|card[-_]?(number|no)?|cvv|cvc|iban|encryption[-_]?key)$/i;

/** Value patterns that look like secrets wherever they appear inside strings. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([?&](?:token|key|api_key|apikey|access_token|code|signature|sig|password|secret)=)[^&#\s]+/gi,
];

export interface RedactOptions {
  /** Exact values to redact wherever they appear (e.g. the configured API key, the user's SSN if known). */
  extraValues?: readonly string[];
  maxDepth?: number;
}

export function redactString(input: string, opts: RedactOptions = {}): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (match: string, prefix?: string) =>
      typeof prefix === "string" && /^[?&]/.test(prefix) ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  for (const v of opts.extraValues ?? []) {
    if (v.length >= 4) out = out.split(v).join(REDACTED);
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** Deep-redacts a value for logging/audit. Returns a new structure; never mutates the input. */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  return walk(value, opts, opts.maxDepth ?? 8, new WeakSet());
}

function walk(value: unknown, opts: RedactOptions, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, opts);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth <= 0) return "[Truncated]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, opts) };
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, opts, depth - 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : walk(v, opts, depth - 1, seen);
  }
  return out;
}
