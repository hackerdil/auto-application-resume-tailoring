import { CareerAgentError, NotFoundError, PolicyError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { matchableFacts, requirementsFromJob } from "../matching/evidence.js";
import type {
  AuditRepository,
  FactRepository,
  JobRepository,
  MatchRepository,
  ProfileRepository,
  ProviderRunRepository,
  ResumeVersionRecord,
  ResumeVersionRepository,
} from "../repositories.js";
import { RunBudget } from "../run-budget.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { CandidateProfile } from "../schemas/profile.js";
import {
  TailoredResume,
  type ResumeEntry,
  type ResumeLength,
  type TailoredBullet,
  type VerifierFinding,
} from "../schemas/resume.js";
import type { RunLimits } from "../schemas/run.js";
import type {
  ArtifactWriter,
  GeneratedBullet,
  GeneratorFact,
  IntegrityReviewer,
  ResumeGenerator,
  ResumeRenderer,
} from "../tailoring/ports.js";
import { selectFacts, type RoleGroup } from "../tailoring/selection.js";
import { validateBullet } from "../tailoring/validator.js";

export const TAILOR_RESUME_TASK = "tailor_resume";
export const tailorKeyPrefix = (jobId: string): string => `tailor:${jobId}:`;

export const DEFAULT_TAILORING_LIMITS: RunLimits = {
  deadlineMs: 300_000,
  maxModelTurns: 12,
  maxToolCalls: 0,
  maxBrowserSteps: 0,
  maxRetries: 1,
  maxInputChars: 60_000,
  maxOutputTokens: 8_000,
  maxCostUsd: 0.75,
};

export interface TailoringDeps {
  jobs: JobRepository;
  facts: FactRepository;
  profiles: ProfileRepository;
  matches: MatchRepository;
  resumes: ResumeVersionRepository;
  providerRuns: ProviderRunRepository;
  audit: AuditRepository;
  renderer: ResumeRenderer;
  artifacts: ArtifactWriter;
  generator?: ResumeGenerator | null;
  reviewer?: IntegrityReviewer | null;
  limits?: RunLimits;
  now?: () => Date;
}

interface Draft {
  key: string;
  entryKey: string | null;
  text: string;
  sourceFactIds: string[];
  targetRequirementKeys: string[];
  transformation: TailoredBullet["transformation"];
  findings: VerifierFinding[];
  review: TailoredBullet["verifier"]["review"];
}

const asGeneratorFact = (f: VerifiedFact): GeneratorFact => ({
  id: f.id,
  claim: f.claim,
  allowedTransformations: f.allowedTransformations,
});
const problemText = (fs: readonly VerifierFinding[]) => fs.map((f) => `${f.kind}: ${f.detail}`);

function header(profile: CandidateProfile | null): TailoredResume["header"] {
  // Contact details appear only when the owner chose "Share on applications" (disclosure "always").
  const shown = (v: { value: string; disclosure: string } | undefined) =>
    v && v.disclosure === "always" ? [v.value] : [];
  return {
    name: profile && profile.fullName.disclosure !== "never" ? profile.fullName.value : "",
    contact: profile
      ? [...shown(profile.email), ...shown(profile.phone), ...shown(profile.location)]
      : [],
    links: profile?.links ?? [],
  };
}

/**
 * Résumé Tailor + Integrity gate (spec §9, §15). Every claim passes the deterministic no-drift validator and, when
 * configured, an independent reviewer. A failing claim gets one revision; if it still fails it is dropped and the
 * reason recorded. Without a generator the résumé uses verified facts verbatim (select/reorder only).
 */
export class TailoringService {
  private readonly now: () => Date;

  constructor(private readonly d: TailoringDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async tailor(
    jobId: string,
    ownerId: string,
    length: ResumeLength,
    traceId: string,
  ): Promise<ResumeVersionRecord> {
    const job = this.d.jobs.get(jobId);
    if (!job) throw new NotFoundError("Job not found.");
    if (job.status === "FILTERED" || job.status === "ARCHIVED")
      throw new PolicyError("Tailoring is only available for eligible jobs.");
    const facts = matchableFacts(this.d.facts.listActive(ownerId));
    if (facts.length === 0)
      throw new PolicyError("Your fact bank is empty. Confirm some facts first.");
    const profile = this.d.profiles.get(ownerId);
    const factsById = new Map(facts.map((f) => [f.id, f]));
    const requirements = requirementsFromJob(job);
    const match = this.d.matches.latestForJob(job.id);
    const cited = new Set(match?.requirements.flatMap((r) => r.factIds) ?? []);
    const sel = selectFacts({
      facts,
      requirementTexts: requirements.map((r) => r.text),
      citedFactIds: cited,
      length,
    });
    const reqKeysFor = (ids: readonly string[]) =>
      (match?.requirements ?? [])
        .filter((r) => r.factIds.some((id) => ids.includes(id)))
        .map((r) => r.key);

    const entries = sel.groups.map((g, i) => ({ entryKey: `E${i}`, group: g }));
    const entryFacts = new Map(
      entries.map((e) => [e.entryKey, new Set(e.group.achievements.map((a) => a.id))]),
    );
    const notes: string[] = [];
    const promptIds = new Set<string>();
    let regenerated = 0;
    const dropped: TailoredResume["dropped"] = [];
    const budget = new RunBudget(this.d.limits ?? DEFAULT_TAILORING_LIMITS);

    // 1. Proposals: model-written, or verbatim facts.
    let drafts: Draft[] = [];
    let summaryDraft: Draft | null = null;
    const verbatim = (e: { entryKey: string; group: RoleGroup }): Draft[] =>
      e.group.achievements.map((a, i) => ({
        key: `${e.entryKey}.${i}`,
        entryKey: e.entryKey,
        text: a.claim,
        sourceFactIds: [a.id],
        targetRequirementKeys: reqKeysFor([a.id]),
        transformation: "select",
        findings: [],
        review: "unavailable",
      }));
    let generated = false;
    if (this.d.generator) {
      try {
        const out = await this.d.generator.generate(
          {
            job: {
              id: job.id,
              title: job.title,
              company: job.company,
              descriptionText: job.descriptionText,
            },
            requirements,
            entries: entries.map((e) => ({
              entryKey: e.entryKey,
              heading: e.group.role?.claim ?? "Selected highlights",
              facts: e.group.achievements.map(asGeneratorFact),
            })),
            summaryFacts: [
              ...sel.skills,
              ...entries.flatMap((e) => (e.group.role ? [e.group.role] : [])),
            ]
              .slice(0, 15)
              .map(asGeneratorFact),
          },
          { budget, traceId },
        );
        out.runs.forEach((r) => {
          this.d.providerRuns.record(r);
        });
        promptIds.add(out.promptId);
        generated = true;
        const known = new Set(entries.map((e) => e.entryKey));
        out.bullets.forEach((b: GeneratedBullet, i) => {
          if (!known.has(b.entryKey)) {
            dropped.push({
              text: b.text,
              sourceFactIds: b.sourceFactIds,
              reason: `Placed under an unknown entry (${b.entryKey}).`,
            });
            return;
          }
          drafts.push({
            key: `${b.entryKey}.${i}`,
            entryKey: b.entryKey,
            text: b.text.trim(),
            sourceFactIds: b.sourceFactIds,
            targetRequirementKeys: b.targetRequirementKeys,
            transformation: b.transformation,
            findings: [],
            review: "pending",
          });
        });
        // An entry the model left empty keeps its verified facts verbatim.
        for (const e of entries)
          if (!drafts.some((d) => d.entryKey === e.entryKey)) drafts.push(...verbatim(e));
        if (out.summary)
          summaryDraft = {
            key: "summary",
            entryKey: null,
            text: out.summary.text.trim(),
            sourceFactIds: out.summary.sourceFactIds,
            targetRequirementKeys: [],
            transformation: "rephrase",
            findings: [],
            review: "pending",
          };
      } catch (err) {
        notes.push(
          `AI writing was unavailable (${err instanceof CareerAgentError ? err.code : "error"}); your verified facts are used verbatim.`,
        );
      }
    } else {
      notes.push(
        "No AI provider is configured; your verified facts are used verbatim, ordered by relevance to this job.",
      );
    }
    if (!generated) drafts = entries.flatMap(verbatim);

    // 2. Deterministic validation, then independent review, with one revision for failures.
    const validate = (d: Draft) => {
      d.findings = validateBullet(d, {
        facts: factsById,
        ...(d.entryKey ? { allowedForEntry: entryFacts.get(d.entryKey) ?? new Set() } : {}),
      });
    };
    const all = () => [...drafts, ...(summaryDraft ? [summaryDraft] : [])];
    all().forEach(validate);
    await this.review(
      all().filter((d) => d.findings.length === 0 && d.review === "pending"),
      factsById,
      budget,
      traceId,
      promptIds,
      notes,
    );

    for (const d of all().filter((x) => x.findings.length > 0 || x.review === "fail")) {
      if (this.d.generator && generated) {
        try {
          const facts2 = d.sourceFactIds
            .map((id) => factsById.get(id))
            .filter((f): f is VerifiedFact => !!f);
          const r = await this.d.generator.revise(
            {
              text: d.text,
              sourceFactIds: d.sourceFactIds,
              transformation: d.transformation,
              problems: problemText(d.findings).concat(
                d.review === "fail"
                  ? ["The independent reviewer found this claim unsupported."]
                  : [],
              ),
              facts: facts2.map(asGeneratorFact),
            },
            { budget, traceId },
          );
          r.runs.forEach((x) => {
            this.d.providerRuns.record(x);
          });
          promptIds.add(r.promptId);
          regenerated++;
          if (r.revised) {
            Object.assign(d, {
              text: r.revised.text.trim(),
              sourceFactIds: r.revised.sourceFactIds,
              transformation: r.revised.transformation,
              review: this.d.reviewer ? "pending" : "unavailable",
            });
            validate(d);
            if (d.findings.length === 0 && d.review === "pending")
              await this.review([d], factsById, budget, traceId, promptIds, notes);
          }
        } catch {
          // Revision failure leaves the claim failing; it is dropped below.
        }
      }
    }
    const passes = (d: Draft) => d.findings.length === 0 && d.review !== "fail";
    for (const d of all().filter((x) => !passes(x))) {
      dropped.push({
        text: d.text,
        sourceFactIds: d.sourceFactIds,
        reason: d.findings.length
          ? problemText(d.findings).join(" ")
          : "The independent reviewer found this claim unsupported.",
      });
    }
    drafts = drafts.filter(passes);
    if (summaryDraft && !passes(summaryDraft)) summaryDraft = null;

    const reviewStatus: TailoredResume["meta"]["review"] =
      !this.d.reviewer || !generated
        ? "unavailable"
        : all().some((d) => d.review === "unavailable")
          ? "unavailable"
          : "pass";
    const toBullet = (d: Draft): TailoredBullet => ({
      id: uuidv7(),
      text: d.text,
      sourceFactIds: [...new Set(d.sourceFactIds)],
      targetRequirementKeys: d.targetRequirementKeys,
      transformation: d.transformation,
      verifier: {
        deterministic: "pass",
        review: d.review === "pending" ? "unavailable" : d.review,
        findings: [],
      },
    });
    const experience: ResumeEntry[] = entries
      .map((e) => ({
        roleFactId: e.group.role?.id ?? null,
        heading: e.group.role?.claim ?? "Selected highlights",
        bullets: drafts.filter((d) => d.entryKey === e.entryKey).map(toBullet),
      }))
      .filter((e) => e.roleFactId !== null || e.bullets.length > 0);
    const item = (f: VerifiedFact) => ({ text: f.claim, factId: f.id });

    let resume = TailoredResume.parse({
      id: uuidv7(),
      jobId: job.id,
      profileVersion: profile?.version ?? 0,
      length,
      createdAt: this.now().toISOString(),
      header: header(profile),
      summary: summaryDraft
        ? {
            text: summaryDraft.text,
            sourceFactIds: [...new Set(summaryDraft.sourceFactIds)],
            verifier: {
              deterministic: "pass",
              review: summaryDraft.review === "pending" ? "unavailable" : summaryDraft.review,
              findings: [],
            },
          }
        : null,
      experience,
      skills: sel.skills.map(item),
      education: sel.education.map(item),
      certifications: sel.certifications.map(item),
      projects: sel.projects.map(item),
      languages: sel.languages.map(item),
      dropped,
      omittedFactIds: sel.omitted.map((f) => f.id),
      meta: {
        mode: generated ? "model-assisted" : "deterministic",
        generator: generated ? (this.d.generator?.name ?? null) : null,
        reviewer: generated ? (this.d.reviewer?.name ?? null) : null,
        review: reviewStatus,
        regenerated,
        promptIds: [...promptIds],
        notes,
      },
    });

    // 3. Render and verify. For one page, remove the least relevant bullets until it fits; fonts are never shrunk.
    let rendered = await this.d.renderer.render(resume);
    for (let i = 0; length === "one-page" && rendered.pageCount > 1 && i < 8; i++) {
      const longest = [...resume.experience].sort((a, b) => b.bullets.length - a.bullets.length)[0];
      if (!longest || longest.bullets.length <= 1) break;
      const removed = longest.bullets.pop();
      if (removed) resume.omittedFactIds.push(...removed.sourceFactIds);
      resume = TailoredResume.parse({
        ...resume,
        meta: {
          ...resume.meta,
          notes: [
            ...resume.meta.notes.filter((n) => !n.startsWith("Shortened")),
            `Shortened to fit one page (${i + 1} bullet(s) removed).`,
          ],
        },
      });
      rendered = await this.d.renderer.render(resume);
    }

    const html = this.d.artifacts.write(
      Buffer.from(rendered.html, "utf8"),
      "html",
      "resume_html",
      "text/html",
    );
    const pdf = this.d.artifacts.write(rendered.pdf, "pdf", "resume_pdf", "application/pdf");
    const docx = this.d.artifacts.write(
      rendered.docx,
      "docx",
      "resume_docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const ok = rendered.checks.every((c) => c.ok);
    const record = this.d.resumes.create({
      resume,
      status: ok ? "draft" : "needs_attention",
      artifactIds: { html: html.id, pdf: pdf.id, docx: docx.id },
      checks: rendered.checks,
    });
    this.d.audit.append({
      traceId,
      runId: null,
      taskId: null,
      applicationId: null,
      jobId: job.id,
      actor: "system",
      type: "resume.tailored",
      prevState: null,
      newState: record.status,
      approvalId: null,
      artifactHashes: [html.sha256, pdf.sha256, docx.sha256],
      provider: resume.meta.generator,
      model: null,
      durationMs: null,
      metadata: {
        resumeId: resume.id,
        mode: resume.meta.mode,
        bullets: experience.reduce((a, e) => a + e.bullets.length, 0),
        dropped: dropped.length,
        regenerated,
        failedChecks: rendered.checks.filter((c) => !c.ok).map((c) => c.name),
      },
    });
    return record;
  }

  decide(resumeId: string, status: "approved" | "rejected", traceId: string): ResumeVersionRecord {
    const rec = this.d.resumes.decide(resumeId, status);
    this.d.audit.append({
      traceId,
      runId: null,
      taskId: null,
      applicationId: null,
      jobId: rec.resume.jobId,
      actor: "user",
      type: `resume.${status}`,
      prevState: "draft",
      newState: status,
      approvalId: null,
      artifactHashes: [rec.artifacts.pdf?.sha256, rec.artifacts.docx?.sha256].filter(
        (x): x is string => !!x,
      ),
      provider: null,
      model: null,
      durationMs: null,
      metadata: { resumeId },
    });
    return rec;
  }

  private async review(
    items: Draft[],
    factsById: ReadonlyMap<string, VerifiedFact>,
    budget: RunBudget,
    traceId: string,
    promptIds: Set<string>,
    notes: string[],
  ): Promise<void> {
    if (items.length === 0) return;
    if (!this.d.reviewer) {
      items.forEach((d) => (d.review = "unavailable"));
      return;
    }
    try {
      const out = await this.d.reviewer.review(
        {
          items: items.map((d) => ({
            itemKey: d.key,
            text: d.text,
            facts: d.sourceFactIds.map((id) => ({ id, claim: factsById.get(id)?.claim ?? "" })),
          })),
        },
        { budget, traceId },
      );
      out.runs.forEach((r) => {
        this.d.providerRuns.record(r);
      });
      promptIds.add(out.promptId);
      for (const d of items) {
        const v = out.verdicts.find((x) => x.itemKey === d.key);
        // A claim the reviewer skipped is not treated as approved.
        d.review = v ? (v.supported ? "pass" : "fail") : "unavailable";
        if (v && !v.supported) d.findings = [];
      }
    } catch (err) {
      items.forEach((d) => (d.review = "unavailable"));
      notes.push(
        `The independent review was unavailable (${err instanceof CareerAgentError ? err.code : "error"}); claims passed the deterministic checks only.`,
      );
    }
  }
}
