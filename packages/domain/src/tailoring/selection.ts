import type { VerifiedFact } from "../schemas/fact.js";
import type { ResumeLength } from "../schemas/resume.js";
import { coverage, tokenSet } from "../matching/text.js";

export interface RoleGroup {
  role: VerifiedFact | null;
  achievements: VerifiedFact[];
}

const ROLE = new Set(["role", "employment"]);
const line = (f: VerifiedFact) => {
  const m = /^line (\d+)$/.exec(f.sourceLocation ?? "");
  return m?.[1] ? Number(m[1]) : null;
};

/**
 * Attributes each achievement to the role it was listed under in the same imported document (nearest preceding
 * role line). Achievements without that provenance go to a separate "highlights" group; they are never attached
 * to an employer by guesswork.
 */
export function groupByRole(facts: readonly VerifiedFact[]): RoleGroup[] {
  const roles = facts.filter((f) => ROLE.has(f.category));
  const groups = new Map<string | null, RoleGroup>(
    roles.map((r) => [r.id, { role: r, achievements: [] }]),
  );
  const other: RoleGroup = { role: null, achievements: [] };
  for (const a of facts.filter((f) => f.category === "achievement")) {
    const al = line(a);
    const owner =
      al === null || !a.sourceArtifactId
        ? undefined
        : roles
            .filter((r) => r.sourceArtifactId === a.sourceArtifactId && (line(r) ?? Infinity) < al)
            .sort((x, y) => (line(y) ?? 0) - (line(x) ?? 0))[0];
    const group = owner ? groups.get(owner.id) : undefined;
    if (group) group.achievements.push(a);
    else other.achievements.push(a);
  }
  // Roles keep their résumé order (chronology is never rearranged); roles without a line keep fact order after them.
  const roleLine = (g: RoleGroup) => (g.role ? (line(g.role) ?? Infinity) : Infinity);
  const ordered = [...groups.values()].sort((x, y) => roleLine(x) - roleLine(y));
  return other.achievements.length ? [...ordered, other] : ordered;
}

export interface SelectionInput {
  facts: readonly VerifiedFact[];
  requirementTexts: readonly string[];
  /** Fact ids cited by the job's match result; they are boosted. */
  citedFactIds: ReadonlySet<string>;
  length: ResumeLength;
}

export interface Selection {
  groups: RoleGroup[];
  skills: VerifiedFact[];
  education: VerifiedFact[];
  certifications: VerifiedFact[];
  projects: VerifiedFact[];
  languages: VerifiedFact[];
  links: VerifiedFact[];
  omitted: VerifiedFact[];
  relevance: ReadonlyMap<string, number>;
}

const CAPS = {
  "one-page": { roles: 3, bulletsPerRole: 3, highlights: 3, skills: 12, other: 4 },
  full: { roles: 12, bulletsPerRole: 6, highlights: 6, skills: 30, other: 10 },
} as const;

/** Deterministic candidate selection: relevance by requirement-term overlap, boosted for facts the match cited. */
export function selectFacts(input: SelectionInput): Selection {
  const reqSets = input.requirementTexts.map((t) => tokenSet(t)).filter((s) => s.size > 0);
  const relevance = new Map<string, number>();
  for (const f of input.facts) {
    const have = tokenSet(f.claim);
    const lexical = reqSets.length ? Math.max(...reqSets.map((r) => coverage(r, have))) : 0;
    relevance.set(f.id, lexical + (input.citedFactIds.has(f.id) ? 1 : 0));
  }
  const rel = (f: VerifiedFact) => relevance.get(f.id) ?? 0;
  const byRelevance = (a: VerifiedFact, b: VerifiedFact) =>
    rel(b) - rel(a) || (line(a) ?? Infinity) - (line(b) ?? Infinity) || a.id.localeCompare(b.id);
  const caps = CAPS[input.length];
  const chosen = new Set<string>();

  const groups = groupByRole(input.facts)
    .filter((g) => g.role !== null)
    .slice(0, caps.roles)
    .map((g) => ({
      role: g.role,
      achievements: [...g.achievements].sort(byRelevance).slice(0, caps.bulletsPerRole),
    }));
  const other = groupByRole(input.facts).find((g) => g.role === null);
  if (other)
    groups.push({
      role: null,
      achievements: [...other.achievements].sort(byRelevance).slice(0, caps.highlights),
    });
  for (const g of groups) {
    if (g.role) chosen.add(g.role.id);
    g.achievements.forEach((a) => chosen.add(a.id));
  }
  const pick = (cat: string, n: number, sort = true) => {
    const list = input.facts.filter((f) => f.category === cat);
    const picked = (sort ? [...list].sort(byRelevance) : list).slice(0, n);
    picked.forEach((f) => chosen.add(f.id));
    return picked;
  };
  const sel = {
    groups: groups.filter((g) => g.role !== null || g.achievements.length > 0),
    skills: pick("skill", caps.skills),
    education: pick("education", caps.other, false),
    certifications: pick("certification", caps.other, false),
    projects: pick("project", caps.other),
    languages: pick("language", caps.other, false),
    links: pick("link", caps.other, false),
  };
  return { ...sel, omitted: input.facts.filter((f) => !chosen.has(f.id)), relevance };
}
