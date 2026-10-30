/** Text normalization shared by matching. Deterministic and dependency-free. */

const STOPWORDS = new Set(
  (
    "a an and or the of in on for to with at by from as is are be been being this that these those it its our your you we " +
    "they their will would can could should must may might do does did have has had not no yes per via into over under " +
    "experience experienced years year yrs strong solid good great excellent proven deep working knowledge understanding " +
    "familiarity familiar proficiency proficient ability able skills skill plus bonus preferred required requirement " +
    "including include such etc using use used other related relevant similar equivalent least minimum ideally also well " +
    "both all any some more most new team teams work role job candidate candidates hands demonstrated track record level"
  ).split(" "),
);

/** Common aliases; the value is the canonical token. */
const SYNONYMS: Record<string, string> = {
  js: "javascript",
  ecmascript: "javascript",
  ts: "typescript",
  postgres: "postgresql",
  psql: "postgresql",
  k8s: "kubernetes",
  golang: "go",
  "react.js": "react",
  reactjs: "react",
  "node.js": "nodejs",
  node: "nodejs",
  "vue.js": "vue",
  py: "python",
  ml: "machine-learning",
  ai: "artificial-intelligence",
  gcp: "google-cloud",
  aws: "amazon-web-services",
  "ci/cd": "cicd",
  ci: "cicd",
  cd: "cicd",
  "c#": "csharp",
  "c++": "cplusplus",
  "f#": "fsharp",
  ".net": "dotnet",
  dotnet: "dotnet",
  sql: "sql",
  nosql: "nosql",
  ux: "user-experience",
  ui: "user-interface",
  saas: "saas",
  b2b: "b2b",
};

const PHRASES: [RegExp, string][] = [
  [/\bmachine learning\b/g, "machine-learning"],
  [/\bartificial intelligence\b/g, "artificial-intelligence"],
  [/\bgoogle cloud( platform)?\b/g, "google-cloud"],
  [/\bamazon web services\b/g, "amazon-web-services"],
  [/\bcontinuous (integration|delivery|deployment)\b/g, "cicd"],
  [/\buser experience\b/g, "user-experience"],
  [/\bdata pipelines?\b/g, "data-pipeline"],
  [/\bdistributed systems?\b/g, "distributed-systems"],
];

/** Light stemming: plural "s" only, so "pipelines" ~ "pipeline" but tool names stay intact. */
const stem = (t: string) =>
  t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;

/** Content tokens of a text: lowercased, aliases resolved, stopwords and pure numbers removed. */
export function tokens(text: string): string[] {
  let s = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  for (const [re, rep] of PHRASES) s = s.replace(re, ` ${rep} `);
  const raw = s.match(/[a-z0-9][a-z0-9+#./-]*[a-z0-9+#]|[a-z0-9]|\.net|c\+\+|c#|f#/g) ?? [];
  const out: string[] = [];
  for (let t of raw) {
    t = t.replace(/[./-]+$/, "");
    if (!t) continue;
    const syn = SYNONYMS[t];
    const tok = syn ?? stem(t);
    if (STOPWORDS.has(tok) || /^\d+(\.\d+)?\+?$/.test(tok) || tok.length < 2) continue;
    out.push(tok);
  }
  return out;
}

export const tokenSet = (text: string): Set<string> => new Set(tokens(text));

/** Share of `needle` tokens present in `haystack` (0..1). Empty needle → 0. */
export function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const t of needle) if (haystack.has(t)) hit++;
  return hit / needle.size;
}

/** "5+ years", "3 yrs", "at least 2 years" → the number, else null. */
export function yearsRequired(text: string): number | null {
  const m = /(\d{1,2})\s*\+?\s*(?:or more\s+)?(?:years|yrs)\b/i.exec(text);
  return m?.[1] ? Number(m[1]) : null;
}

export type SeniorityLevel =
  | "intern"
  | "junior"
  | "mid"
  | "senior"
  | "lead"
  | "staff"
  | "principal"
  | "manager"
  | "director"
  | "executive"
  | "unknown";

const SENIORITY_RULES: [RegExp, SeniorityLevel][] = [
  [/\b(intern|internship|werkstudent)\b/i, "intern"],
  [/\b(chief|vp|vice president|head of)\b/i, "executive"],
  [/\bdirector\b/i, "director"],
  [/\bprincipal\b/i, "principal"],
  [/\bstaff\b/i, "staff"],
  [/\b(lead|tech lead)\b/i, "lead"],
  [/\bmanager\b/i, "manager"],
  [/\b(senior|sr\.?)\b/i, "senior"],
  [/\b(junior|jr\.?|entry[- ]level|graduate)\b/i, "junior"],
  [/\b(mid[- ]level|intermediate)\b/i, "mid"],
];

/** Seniority from explicit title words only; otherwise "unknown" (never guessed). */
export function seniorityFromTitle(title: string): SeniorityLevel {
  for (const [re, s] of SENIORITY_RULES) if (re.test(title)) return s;
  return "unknown";
}

/** Individual-contributor ladder rank; management titles map onto comparable ranks. */
export const SENIORITY_RANK: Record<Exclude<SeniorityLevel, "unknown">, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  manager: 4,
  staff: 5,
  principal: 6,
  director: 6,
  executive: 7,
};
