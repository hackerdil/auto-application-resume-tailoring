#!/usr/bin/env node
// Fails if fixture or example files contain obvious real personal data or secrets (spec §31).
// Fixtures must use fictional data: example.com/example.org/.test domains, 555-01xx phone numbers.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid))$/i;

export const RULES = [
  { name: "OpenAI API key", re: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { name: "US SSN", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  {
    name: "Payment card number",
    re: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2})[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\b/,
  },
  // Phone numbers outside the fictional 555-0100..0199 range.
  {
    name: "Phone number",
    re: /(?<![\d-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/,
    allow: /555[ .-]01\d\d/,
  },
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * @param {string} text
 * @returns {string[]} names of findings
 */
export function scanText(text) {
  const findings = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m && !(rule.allow && rule.allow.test(m[0]))) findings.push(rule.name);
  }
  for (const email of text.match(EMAIL_RE) ?? []) {
    if (!ALLOWED_EMAIL_DOMAINS.test(email))
      findings.push(`Non-fictional email (${email.replace(/^[^@]+/, "***")})`);
  }
  return findings;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".gitkeep") continue;
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.size <= 5 * 1024 * 1024) yield p;
  }
}

/** @param {string} root */
export function scanRepo(root) {
  const targets = ["fixtures", ".env.example", "CLAUDE.local.md.example"].map((t) =>
    path.join(root, t),
  );
  const results = [];
  for (const t of targets) {
    let st;
    try {
      st = statSync(t);
    } catch {
      continue;
    }
    const files = st.isDirectory() ? [...walk(t)] : [t];
    for (const f of files) {
      const findings = scanText(readFileSync(f, "utf8"));
      if (findings.length) results.push({ file: path.relative(root, f), findings });
    }
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = scanRepo(process.cwd());
  for (const r of results) console.error(`${r.file}: ${r.findings.join(", ")}`);
  process.exit(results.length ? 1 : 0);
}
