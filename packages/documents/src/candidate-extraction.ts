import type { FactCategory, RunLimits } from "@career-agent/domain";
import {
  CandidateFactsOutput,
  renderResumeExtraction,
  RESUME_EXTRACTION_PROMPT,
  runStructured,
  type AIProvider,
} from "@career-agent/ai";

export interface CandidateFact {
  category: FactCategory;
  claim: string;
  evidenceText: string;
  sourceLocation: string | null;
  extractor: "deterministic" | "model";
  sensitive: boolean;
}

export interface ExtractionReport {
  candidates: CandidateFact[];
  /** Model candidates dropped because their evidence or numbers were not in the document. */
  rejected: number;
  modelUsed: boolean;
  warnings: string[];
}

const SENSITIVE_CATEGORIES: ReadonlySet<FactCategory> = new Set([
  "identity",
  "contact",
  "work_authorization",
]);

const BULLET_RE = /^[•\-*‣▪●◦–]\s+/;
const DATE_RANGE_RE = /\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|present|current|now)\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s|,;]+/g;
const DEGREE_RE =
  /\b(BSc|BA|BS|MSc|MS|MA|MBA|PhD|MEng|BEng|Bachelor|Master|Doctor(ate)?|Diploma|Associate)\b/;
const SKILLS_RE = /^(skills|technical skills|technologies|tools)\s*:\s*(.+)$/i;

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Deterministic, conservative extraction: every candidate's evidence is a verbatim line of the document. */
export function extractCandidatesDeterministic(text: string): CandidateFact[] {
  const out: CandidateFact[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line) return;
    const loc = `line ${i + 1}`;
    const add = (category: FactCategory, claim: string) => {
      out.push({
        category,
        claim,
        evidenceText: line,
        sourceLocation: loc,
        extractor: "deterministic",
        sensitive: SENSITIVE_CATEGORIES.has(category),
      });
    };
    for (const email of line.match(EMAIL_RE) ?? []) add("contact", `Email: ${email}`);
    for (const url of line.match(URL_RE) ?? []) add("link", url);
    const skills = SKILLS_RE.exec(line);
    if (skills?.[2]) {
      for (const s of skills[2]
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean))
        add("skill", s);
      return;
    }
    if (BULLET_RE.test(line)) {
      add("achievement", line.replace(BULLET_RE, ""));
      return;
    }
    if (DEGREE_RE.test(line)) {
      add("education", line);
      return;
    }
    if (DATE_RANGE_RE.test(line)) add("role", line);
  });
  return out;
}

/** Numbers stated in a claim must appear in its evidence (cheap guard against invented metrics). */
function numbersSupported(claim: string, evidence: string): boolean {
  const ev = new Set(evidence.match(/\d+(?:[.,]\d+)?/g) ?? []);
  return (claim.match(/\d+(?:[.,]\d+)?/g) ?? []).every((n) => ev.has(n));
}

export interface ExtractOptions {
  provider?: AIProvider | null;
  limits?: RunLimits;
  signal?: AbortSignal;
  traceId?: string;
  artifactId?: string;
}

/**
 * Deterministic extraction always runs. If a provider is supplied, its candidates are added only when
 * their evidence is a verbatim excerpt of the document and their numbers appear in that evidence.
 * Provider failures degrade to deterministic results with a warning.
 */
export async function extractCandidates(
  text: string,
  opts: ExtractOptions = {},
): Promise<ExtractionReport> {
  const candidates = extractCandidatesDeterministic(text);
  const warnings: string[] = [];
  let rejected = 0;
  let modelUsed = false;

  if (opts.provider && opts.limits && opts.signal && opts.traceId) {
    try {
      const result = await runStructured({
        provider: opts.provider,
        taskType: "resume_extraction",
        prompt: RESUME_EXTRACTION_PROMPT,
        messages: renderResumeExtraction(text, opts.artifactId ?? "resume"),
        schema: CandidateFactsOutput,
        limits: opts.limits,
        signal: opts.signal,
        traceId: opts.traceId,
      });
      modelUsed = true;
      const doc = squash(text);
      for (const c of result.value.candidates) {
        if (!doc.includes(squash(c.evidenceText)) || !numbersSupported(c.claim, c.evidenceText)) {
          rejected++;
          continue;
        }
        candidates.push({
          category: c.category,
          claim: c.claim.trim(),
          evidenceText: c.evidenceText.trim(),
          sourceLocation: null,
          extractor: "model",
          sensitive: SENSITIVE_CATEGORIES.has(c.category),
        });
      }
      if (rejected)
        warnings.push(
          `${rejected} suggested item(s) were discarded because they were not supported by the document text.`,
        );
    } catch {
      warnings.push("AI-assisted extraction was unavailable; showing rule-based suggestions only.");
    }
  }

  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.category}|${squash(c.claim)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { candidates: unique, rejected, modelUsed, warnings };
}
