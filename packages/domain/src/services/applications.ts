import { CareerAgentError, NotFoundError, PolicyError, ValidationError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { matchableFacts, requirementsFromJob } from "../matching/evidence.js";
import type {
  ApplicationFieldRepository,
  ApplicationRepository,
  AuditRepository,
  CoverLetterRecord,
  CoverLetterRepository,
  FactRepository,
  JobRepository,
  NewAuditEvent,
  ProfileRepository,
  ProviderRunRepository,
  ResumeVersionRepository,
  SavedAnswerRepository,
} from "../repositories.js";
import { RunBudget } from "../run-budget.js";
import type {
  Application,
  ApplicationAnswer,
  ApplicationField,
  ApplicationState,
  FieldType,
} from "../schemas/application.js";
import { ApplicationAnswer as AnswerSchema, isAnswerSetComplete } from "../schemas/application.js";
import type { VerifiedFact } from "../schemas/fact.js";
import type { Job } from "../schemas/job.js";
import { CoverLetter, coverLetterText, type LetterSegment } from "../schemas/resume.js";
import type { RunLimits } from "../schemas/run.js";
import { assertApplicationTransition } from "../state/application.js";
import type { ArtifactWriter, GeneratorFact } from "../tailoring/ports.js";
import { selectFacts } from "../tailoring/selection.js";
import { validateBullet } from "../tailoring/validator.js";
import { checkConsistency, type ConsistencyFinding } from "../drafting/consistency.js";
import { validateMotivation } from "../drafting/motivation.js";
import { planAnswer, type PlannerContext } from "../drafting/planner.js";
import type { ApplicationDrafter, CoverLetterRenderer, DraftSegment } from "../drafting/ports.js";
import { normalizeQuestion } from "./profile.js";

export const DRAFT_COVER_LETTER_TASK = "draft_cover_letter";
export const coverLetterKeyPrefix = (applicationId: string): string => `cover:${applicationId}:`;
/** Phase 7 browser tasks: open/continue preparing the form, and close its browser. Run by the worker that owns the window. */
export const PREPARE_APPLICATION_TASK = "prepare_application";
export const CLOSE_BROWSER_TASK = "close_browser";
export const browserKeyPrefix = (applicationId: string): string => `browser:${applicationId}:`;

/** Questions most application forms ask; added on request so the owner can prepare before opening the form. */
export const COMMON_QUESTIONS: readonly {
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}[] = [
  { label: "First name", type: "text", required: true },
  { label: "Last name", type: "text", required: true },
  { label: "Email", type: "email", required: true },
  { label: "Phone", type: "tel", required: false },
  { label: "Current location (city)", type: "text", required: false },
  { label: "LinkedIn profile", type: "url", required: false },
  { label: "Resume/CV", type: "file", required: true },
  { label: "Cover letter", type: "file", required: false },
  { label: "Why do you want to work at {company}?", type: "textarea", required: false },
  {
    label: "Are you legally authorized to work in the country where this job is located?",
    type: "radio",
    required: true,
    options: ["Yes", "No"],
  },
  {
    label: "Will you now or in the future require sponsorship for employment visa status?",
    type: "radio",
    required: true,
    options: ["Yes", "No"],
  },
  { label: "What are your salary expectations?", type: "text", required: false },
  { label: "What is your notice period or earliest start date?", type: "text", required: false },
  { label: "How did you hear about this job?", type: "text", required: false },
];

/** A question read from the application form by a browser adapter (Phase 7). */
export interface PageQuestion {
  label: string;
  /** The control's name attribute, used to tell unlabelled questions apart. */
  name: string;
  type: FieldType;
  required: boolean;
  options: string[];
  ambiguous: boolean;
}

const PREPARABLE: readonly ApplicationState[] = [
  "READY_TO_PREPARE",
  "PREPARING",
  "AWAITING_USER_INPUT",
  "READY_FOR_REVIEW",
];

export const DEFAULT_DRAFTING_LIMITS: RunLimits = {
  deadlineMs: 180_000,
  maxModelTurns: 10,
  maxToolCalls: 0,
  maxBrowserSteps: 0,
  maxRetries: 1,
  maxInputChars: 50_000,
  maxOutputTokens: 6_000,
  maxCostUsd: 0.5,
};

export interface ApplicationDeps {
  applications: ApplicationRepository;
  fields: ApplicationFieldRepository;
  coverLetters: CoverLetterRepository;
  resumes: ResumeVersionRepository;
  jobs: JobRepository;
  facts: FactRepository;
  profiles: ProfileRepository;
  savedAnswers: SavedAnswerRepository;
  providerRuns: ProviderRunRepository;
  audit: AuditRepository;
  renderer: CoverLetterRenderer;
  artifacts: ArtifactWriter;
  drafter?: ApplicationDrafter | null;
  limits?: RunLimits;
  now?: () => Date;
  /** Unit of work for multi-repository changes; defaults to running `fn` directly. */
  uow?: <T>(fn: () => T) => T;
}

export interface ApplicationOverview {
  application: Application;
  job: Job;
  answers: ApplicationAnswer[];
  /** Questions waiting for the owner, most important first. */
  pending: ApplicationAnswer[];
  answersComplete: boolean;
  consistency: ConsistencyFinding[];
  materialsReady: boolean;
}

const event = (
  traceId: string,
  applicationId: string,
  jobId: string,
  type: string,
  metadata: Record<string, unknown>,
  actor: NewAuditEvent["actor"] = "user",
): NewAuditEvent => ({
  traceId,
  runId: null,
  taskId: null,
  applicationId,
  jobId,
  actor,
  type,
  prevState: null,
  newState: null,
  approvalId: null,
  artifactHashes: [],
  provider: null,
  model: null,
  durationMs: null,
  // Never the answer text: categories and decisions only.
  metadata,
});

const asGeneratorFact = (f: VerifiedFact): GeneratorFact => ({
  id: f.id,
  claim: f.claim,
  allowedTransformations: f.allowedTransformations,
});
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const problemText = (fs: readonly { kind: string; detail: string }[]) =>
  fs.map((f) => `${f.kind}: ${f.detail}`);

/** Order in which the state machine is walked forward before preparation (READY_FOR_REVIEW needs `markReadyForReview`). */
const FORWARD: ApplicationState[] = [
  "DRAFT",
  "TAILORING",
  "VERIFYING",
  "READY_TO_PREPARE",
  "PREPARING",
];

/**
 * Application Drafter workflow (spec §9, §16; Phases 6–7): materials (approved résumé, cover letter), questions with
 * deterministic classification and planned answers, owner answers, a consistency review, questions read from the
 * live form, and the move to READY_FOR_REVIEW. It never touches a browser and never approves or submits.
 */
export class ApplicationService {
  private readonly now: () => Date;
  private readonly d: ApplicationDeps & { uow: <T>(fn: () => T) => T };

  constructor(deps: ApplicationDeps) {
    this.d = { ...deps, uow: deps.uow ?? ((fn) => fn()) };
    this.now = deps.now ?? (() => new Date());
  }

  create(ownerId: string, jobId: string, traceId: string): Application {
    const job = this.d.jobs.get(jobId);
    if (!job) throw new NotFoundError("Job not found.");
    if (!["ELIGIBLE", "SCORED", "SHORTLISTED"].includes(job.status))
      throw new PolicyError(
        "Applications can only be started for eligible, scored, or shortlisted jobs.",
      );
    return (
      this.d.applications.findForJob(ownerId, jobId) ??
      this.d.applications.create(ownerId, jobId, traceId)
    );
  }

  overview(ownerId: string, applicationId: string): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const job = this.job(app);
    const answers = this.d.fields.list(app.id);
    const resume = app.resumeVersionId ? this.d.resumes.get(app.resumeVersionId) : null;
    const letter = app.coverLetterVersionId
      ? this.d.coverLetters.get(app.coverLetterVersionId)
      : null;
    const consistency = checkConsistency({
      job,
      profile: this.d.profiles.get(ownerId),
      facts: this.allFacts(ownerId, [
        ...answers.flatMap((a) =>
          a.provenance.kind === "facts" || a.provenance.kind === "draft"
            ? a.provenance.factIds
            : [],
        ),
        ...(resume?.resume.experience.flatMap((e) => e.bullets.flatMap((b) => b.sourceFactIds)) ??
          []),
        ...(letter?.letter.paragraphs.flat().flatMap((s) => s.factIds) ?? []),
      ]),
      resume: resume ? { resume: resume.resume, status: resume.status } : null,
      coverLetter: letter ? { letter: letter.letter, status: letter.status } : null,
      coverLetterSkipped: app.coverLetterSkipped,
      answers,
    });
    const rank = { requires_user: 0, needs_review: 1, auto_fill: 2, prohibited: 3 } as const;
    const pending = answers
      .filter(
        (a) =>
          a.decision !== "prohibited" &&
          a.finalValue === null &&
          (a.field.required || a.decision === "requires_user" || a.proposedValue !== null),
      )
      .sort(
        (a, b) =>
          rank[a.decision] - rank[b.decision] ||
          Number(b.field.required) - Number(a.field.required),
      );
    const materialsReady = !consistency.some(
      (f) => f.severity === "high" && (f.location === "résumé" || f.location === "cover letter"),
    );
    return {
      application: app,
      job,
      answers,
      pending,
      answersComplete: isAnswerSetComplete(answers),
      consistency,
      materialsReady,
    };
  }

  selectResume(
    ownerId: string,
    applicationId: string,
    resumeVersionId: string,
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const r = this.d.resumes.get(resumeVersionId);
    if (!r || r.resume.jobId !== app.jobId)
      throw new ValidationError("That résumé was not tailored for this job.");
    if (r.status !== "approved")
      throw new PolicyError("Approve the résumé before using it in an application.");
    this.d.applications.setMaterials(app.id, { resumeVersionId });
    this.d.audit.append(
      event(traceId, app.id, app.jobId, "application.resume_selected", { resumeVersionId }),
    );
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  skipCoverLetter(
    ownerId: string,
    applicationId: string,
    skip: boolean,
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    this.d.applications.setMaterials(app.id, {
      coverLetterSkipped: skip,
      ...(skip ? { coverLetterVersionId: null } : {}),
    });
    this.d.audit.append(
      event(traceId, app.id, app.jobId, "application.cover_letter_skipped", { skip }),
    );
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  decideCoverLetter(
    ownerId: string,
    applicationId: string,
    letterId: string,
    status: "approved" | "rejected",
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const rec = this.d.coverLetters.get(letterId);
    if (!rec || rec.letter.applicationId !== app.id)
      throw new NotFoundError("Cover letter not found.");
    const decided = this.d.coverLetters.decide(letterId, status);
    if (status === "approved")
      this.d.applications.setMaterials(app.id, {
        coverLetterVersionId: letterId,
        coverLetterSkipped: false,
      });
    this.d.audit.append({
      ...event(traceId, app.id, app.jobId, `cover_letter.${status}`, { letterId }),
      artifactHashes: [decided.artifacts.pdf?.sha256].filter((x): x is string => !!x),
    });
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  addQuestions(
    ownerId: string,
    applicationId: string,
    questions: readonly {
      label: string;
      type: FieldType;
      required: boolean;
      options?: readonly string[];
    }[],
    origin: ApplicationField["origin"],
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const job = this.job(app);
    const existing = new Set(this.d.fields.list(app.id).map((a) => a.field.normalizedQuestion));
    const ctx = this.plannerContext(ownerId, app, new Map());
    const fresh = questions
      .map((q) => ({ ...q, label: q.label.replace("{company}", job.company).trim() }))
      .filter((q) => q.label && !existing.has(normalizeQuestion(q.label)))
      .map((q) =>
        planAnswer(
          {
            id: uuidv7(),
            label: q.label,
            normalizedQuestion: normalizeQuestion(q.label),
            type: q.type,
            required: q.required,
            options: [...(q.options ?? [])],
            category: "unknown",
            origin,
          },
          ctx,
        ),
      );
    this.d.fields.add(app.id, fresh);
    this.d.audit.append(
      event(traceId, app.id, app.jobId, "application.questions_added", {
        count: fresh.length,
        origin,
        categories: fresh.map((a) => a.field.category),
      }),
    );
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  removeQuestion(
    ownerId: string,
    applicationId: string,
    fieldId: string,
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const a = this.d.fields.list(app.id).find((x) => x.field.id === fieldId);
    if (!a) throw new NotFoundError("Question not found.");
    if (a.field.origin === "page")
      throw new PolicyError("Questions read from the application form cannot be removed.");
    this.d.fields.remove(app.id, fieldId);
    this.d.audit.append(
      event(traceId, app.id, app.jobId, "application.question_removed", {
        fieldId,
        category: a.field.category,
      }),
    );
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  /** The owner's own answer (or accepting the proposal with `useProposal`). Prohibited fields are refused. */
  answer(
    ownerId: string,
    applicationId: string,
    fieldId: string,
    input: { value: string | null } | { useProposal: true },
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const a = this.d.fields.list(app.id).find((x) => x.field.id === fieldId);
    if (!a) throw new NotFoundError("Question not found.");
    if (a.decision === "prohibited")
      throw new PolicyError(
        "You answer this one yourself, directly in the application form. Career Agent never fills it.",
      );
    const value = "useProposal" in input ? a.proposedValue : input.value?.trim() || null;
    if ("useProposal" in input && value === null)
      throw new ValidationError("There is no proposed answer to accept.");
    if (
      value !== null &&
      a.field.options.length &&
      a.field.type !== "checkbox" &&
      !a.field.options.includes(value)
    )
      throw new ValidationError("Choose one of the listed options.");
    if (value !== null && value.length > 10_000)
      throw new ValidationError("The answer is too long.");
    const next = AnswerSchema.parse({
      ...a,
      finalValue: value,
      finalValueSetBy: value === null ? null : "user",
      provenance: "useProposal" in input ? a.provenance : { kind: "user" },
      reviewerChanges: [
        ...a.reviewerChanges,
        `${this.now().toISOString()}: ${value === null ? "cleared" : "useProposal" in input ? "accepted proposal" : "answered"} by owner`,
      ].slice(-20),
    });
    this.d.fields.saveAnswer(app.id, next);
    this.d.audit.append(
      event(traceId, app.id, app.jobId, "application.answer_set", {
        fieldId,
        category: a.field.category,
        decision: a.decision,
        accepted: "useProposal" in input,
        cleared: value === null,
      }),
    );
    return this.afterChange(ownerId, app.id, traceId, true);
  }

  /**
   * Phase 7: questions read from the live application form become the application's questions (origin "page").
   * An earlier hand-added question with the same wording is replaced by the form's version, keeping the owner's
   * answer when it still fits. Questions without a usable label always wait for the owner.
   */
  syncPageFields(
    ownerId: string,
    applicationId: string,
    questions: readonly PageQuestion[],
    traceId: string,
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    if (!PREPARABLE.includes(app.state))
      throw new PolicyError(`Questions cannot be read from the form in state ${app.state}.`);
    const byQuestion = new Map(
      this.d.fields.list(app.id).map((a) => [a.field.normalizedQuestion, a] as const),
    );
    const ctx = this.plannerContext(ownerId, app, new Map());
    const fresh: ApplicationAnswer[] = [];
    const replaced: string[] = [];
    const seen = new Set<string>();
    for (const q of questions) {
      const label = (q.ambiguous ? `${q.label} (${q.name || "unlabelled"})` : q.label)
        .trim()
        .slice(0, 500);
      const normalized = normalizeQuestion(label);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const prior = byQuestion.get(normalized);
      const options = q.options.slice(0, 200);
      const sameShape =
        prior?.field.type === q.type &&
        prior.field.required === q.required &&
        prior.field.options.join("\u0000") === options.join("\u0000");
      if (prior && (prior.field.origin === "page" || sameShape)) continue;
      let planned = planAnswer(
        {
          id: uuidv7(),
          label,
          normalizedQuestion: normalized,
          type: q.type,
          required: q.required,
          options,
          category: "unknown",
          origin: "page",
        },
        ctx,
      );
      if (q.ambiguous && planned.decision !== "prohibited")
        planned = AnswerSchema.parse({
          ...planned,
          decision: "requires_user",
          proposedValue: null,
          finalValue: null,
          finalValueSetBy: null,
          provenance: { kind: "none" },
          notes: [
            ...planned.notes,
            "The form does not say clearly what this asks. Look at it in the browser and answer it yourself.",
          ],
        });
      const kept = prior?.finalValueSetBy === "user" ? prior.finalValue : null;
      if (
        kept !== null &&
        planned.decision !== "prohibited" &&
        (!options.length || q.type === "checkbox" || options.includes(kept))
      )
        planned = AnswerSchema.parse({
          ...planned,
          finalValue: kept,
          finalValueSetBy: "user",
          provenance: prior?.provenance ?? { kind: "user" },
          reviewerChanges: [
            ...(prior?.reviewerChanges ?? []),
            `${this.now().toISOString()}: kept for the form's version of this question`,
          ].slice(-20),
        });
      if (prior) replaced.push(prior.field.id);
      fresh.push(planned);
    }
    this.d.uow(() => {
      for (const id of replaced) this.d.fields.remove(app.id, id);
      this.d.fields.add(app.id, fresh);
      this.d.audit.append(
        event(
          traceId,
          app.id,
          app.jobId,
          "application.page_fields_synced",
          {
            added: fresh.length,
            replaced: replaced.length,
            categories: fresh.map((a) => a.field.category),
          },
          "system",
        ),
      );
    });
    return this.afterChange(ownerId, app.id, traceId);
  }

  /**
   * Phase 7: preparation finished. Only a complete answer set, ready materials, and a form with no empty required
   * fields or errors (`blockers`, from the browser readiness checklist) reach READY_FOR_REVIEW.
   */
  markReadyForReview(
    ownerId: string,
    applicationId: string,
    blockers: readonly string[],
    traceId: string,
  ): ApplicationOverview {
    const o = this.afterChange(ownerId, applicationId, traceId);
    let app = o.application;
    if (app.state !== "PREPARING")
      throw new PolicyError(`The application is ${app.state}, not PREPARING.`);
    if (!o.answers.some((a) => a.field.origin === "page"))
      throw new PolicyError("Prepare the application form in the browser first.");
    if (!o.materialsReady)
      throw new PolicyError("The résumé or cover letter needs attention first.");
    if (!o.answersComplete)
      throw new PolicyError("Some required questions still need your answer.");
    if (blockers.length)
      throw new PolicyError(`The form still needs attention: ${blockers.slice(0, 5).join(" ")}`);
    const ctx = {
      actor: "system" as const,
      mode: "review-each" as const,
      answerSetComplete: true,
    };
    assertApplicationTransition(app.state, "READY_FOR_REVIEW", ctx);
    app = this.d.applications.transition(app.id, "READY_FOR_REVIEW", { ...ctx, traceId });
    return { ...o, application: app };
  }

  /** The answers preparation may type into the form (finalized ones only are ever used by the browser tools). */
  answersFor(ownerId: string, applicationId: string): ApplicationAnswer[] {
    return this.d.fields.list(this.owned(ownerId, applicationId).id);
  }

  /** Hash-addressed approved files for upload; the caller verifies bytes against the hash before use. */
  approvedFileRef(
    ownerId: string,
    applicationId: string,
    kind: "resume" | "cover_letter",
  ): { artifactId: string; sha256: string } | null {
    const app = this.owned(ownerId, applicationId);
    if (kind === "resume") {
      const r = app.resumeVersionId ? this.d.resumes.get(app.resumeVersionId) : null;
      return r?.status === "approved" && r.artifacts.pdf
        ? { artifactId: r.artifacts.pdf.id, sha256: r.artifacts.pdf.sha256 }
        : null;
    }
    const l = app.coverLetterVersionId ? this.d.coverLetters.get(app.coverLetterVersionId) : null;
    return l?.status === "approved" && l.artifacts.pdf
      ? { artifactId: l.artifacts.pdf.id, sha256: l.artifacts.pdf.sha256 }
      : null;
  }

  /** Re-plans answers the owner has not set (e.g. after saving answers or approving materials). */
  replan(
    ownerId: string,
    applicationId: string,
    traceId: string,
    drafts: ReadonlyMap<string, { text: string; factIds: string[] }> = new Map(),
  ): ApplicationOverview {
    const app = this.owned(ownerId, applicationId);
    const ctx = this.plannerContext(ownerId, app, drafts);
    for (const a of this.d.fields.list(app.id)) {
      if (a.finalValueSetBy === "user") continue;
      const planned = planAnswer(a.field, ctx);
      const keepDraft =
        a.provenance.kind === "draft" &&
        !drafts.has(a.field.id) &&
        planned.provenance.kind === "none";
      if (!keepDraft) this.d.fields.saveAnswer(app.id, planned);
    }
    return this.afterChange(ownerId, app.id, traceId);
  }

  /** Drafts free-text answers with the model; each sentence is validated like a résumé line. */
  async draftAnswers(
    ownerId: string,
    applicationId: string,
    traceId: string,
  ): Promise<{
    overview: ApplicationOverview;
    drafted: number;
    dropped: { text: string; reason: string }[];
    note: string | null;
  }> {
    const app = this.owned(ownerId, applicationId);
    const job = this.job(app);
    if (!this.d.drafter)
      return {
        overview: this.overview(ownerId, app.id),
        drafted: 0,
        dropped: [],
        note: "No AI provider is configured; write these answers yourself.",
      };
    const facts = matchableFacts(this.d.facts.listActive(ownerId));
    const questions = this.d.fields
      .list(app.id)
      .filter(
        (a) =>
          ["motivation", "experience_story", "additional_info", "cover_letter_text"].includes(
            a.field.category,
          ) && a.finalValueSetBy !== "user",
      )
      .map((a) => ({ fieldId: a.field.id, label: a.field.label }));
    if (questions.length === 0)
      return {
        overview: this.overview(ownerId, app.id),
        drafted: 0,
        dropped: [],
        note: "No questions need drafting.",
      };
    const budget = new RunBudget(this.d.limits ?? DEFAULT_DRAFTING_LIMITS);
    const drafts = new Map<string, { text: string; factIds: string[] }>();
    const dropped: { text: string; sourceFactIds: string[]; reason: string }[] = [];
    try {
      const out = await this.d.drafter.draftAnswers(
        { job, questions, facts: facts.map(asGeneratorFact) },
        { budget, traceId },
      );
      out.runs.forEach((r) => {
        this.d.providerRuns.record(r);
      });
      for (const a of out.answers) {
        if (!questions.some((q) => q.fieldId === a.fieldId)) continue;
        const { kept } = await this.verifySegments(
          a.segments,
          facts,
          job,
          budget,
          traceId,
          dropped,
        );
        if (kept.length)
          drafts.set(a.fieldId, {
            text: kept.map((s) => sentence(s.text)).join(" "),
            factIds: [...new Set(kept.flatMap((s) => s.factIds))],
          });
      }
    } catch (err) {
      return {
        overview: this.overview(ownerId, app.id),
        drafted: 0,
        dropped,
        note: `AI drafting was unavailable (${err instanceof CareerAgentError ? err.code : "error"}).`,
      };
    }
    this.d.audit.append(
      event(
        traceId,
        app.id,
        app.jobId,
        "application.answers_drafted",
        { drafted: drafts.size, dropped: dropped.length },
        "system",
      ),
    );
    return {
      overview: this.replan(ownerId, app.id, traceId, drafts),
      drafted: drafts.size,
      dropped,
      note: null,
    };
  }

  /** Builds, verifies, renders, and stores a cover letter version (run by the worker). */
  async draftCoverLetter(
    ownerId: string,
    applicationId: string,
    traceId: string,
  ): Promise<CoverLetterRecord> {
    const app = this.owned(ownerId, applicationId);
    const job = this.job(app);
    const facts = matchableFacts(this.d.facts.listActive(ownerId));
    if (facts.length === 0)
      throw new PolicyError("Your fact bank is empty. Confirm some facts first.");
    const profile = this.d.profiles.get(ownerId);
    const requirements = requirementsFromJob(job);
    const notes: string[] = [];
    const dropped: { text: string; sourceFactIds: string[]; reason: string }[] = [];
    let mode: "deterministic" | "model-assisted" = "deterministic";
    let regenerated = 0;
    const promptIds: string[] = [];
    let body: LetterSegment[][] = [];

    if (this.d.drafter) {
      const budget = new RunBudget(this.d.limits ?? DEFAULT_DRAFTING_LIMITS);
      try {
        const out = await this.d.drafter.draftCoverLetter(
          { job, requirements, facts: facts.map(asGeneratorFact) },
          { budget, traceId },
        );
        out.runs.forEach((r) => {
          this.d.providerRuns.record(r);
        });
        promptIds.push(out.promptId);
        for (const para of out.paragraphs) {
          const { kept, revisions } = await this.verifySegments(
            para,
            facts,
            job,
            budget,
            traceId,
            dropped,
          );
          regenerated += revisions;
          if (kept.length)
            body.push(
              kept.map((x) => ({
                kind: x.kind,
                text: sentence(x.text),
                factIds: x.factIds,
                transformation: x.transformation,
              })),
            );
        }
        if (body.length) mode = "model-assisted";
        else
          notes.push(
            "Every AI-written sentence failed verification; the letter uses your verified facts verbatim.",
          );
      } catch (err) {
        notes.push(
          `AI writing was unavailable (${err instanceof CareerAgentError ? err.code : "error"}); the letter uses your verified facts verbatim.`,
        );
        body = [];
      }
    } else {
      notes.push(
        "No AI provider is configured; the letter states your most relevant verified facts verbatim. Add your own reasons for applying before approving.",
      );
    }
    if (body.length === 0) {
      const sel = selectFacts({
        facts,
        requirementTexts: requirements.map((r) => r.text),
        citedFactIds: new Set(),
        length: "one-page",
      });
      const top = sel.groups
        .flatMap((g) => g.achievements)
        .sort((a, b) => (sel.relevance.get(b.id) ?? 0) - (sel.relevance.get(a.id) ?? 0))
        .slice(0, 3);
      body = top.length
        ? [
            top.map((f) => ({
              kind: "fact" as const,
              text: sentence(f.claim),
              factIds: [f.id],
              transformation: "select" as const,
            })),
          ]
        : [];
      if (top.length === 0)
        notes.push(
          "Your fact bank has no achievements to cite, so the letter only states the position. Confirm achievement facts or write the body yourself.",
        );
    }
    const letter = CoverLetter.parse({
      id: uuidv7(),
      applicationId: app.id,
      jobId: job.id,
      createdAt: this.now().toISOString(),
      greeting: `Dear ${job.company} hiring team,`,
      paragraphs: [
        [
          {
            kind: "courtesy",
            text: `I am applying for the ${job.title} position at ${job.company}.`,
            factIds: [],
            transformation: null,
          },
        ],
        ...body,
      ],
      closing: "Thank you for considering my application.",
      signature: profile && profile.fullName.disclosure !== "never" ? profile.fullName.value : "",
      dropped,
      meta: {
        mode,
        generator: mode === "model-assisted" ? (this.d.drafter?.name ?? null) : null,
        reviewer: null,
        review: "unavailable",
        regenerated,
        promptIds,
        notes,
      },
    });
    const rendered = await this.d.renderer.render(letter);
    const html = this.d.artifacts.write(
      Buffer.from(rendered.html, "utf8"),
      "html",
      "cover_letter_html",
      "text/html",
    );
    const pdf = this.d.artifacts.write(rendered.pdf, "pdf", "cover_letter_pdf", "application/pdf");
    const docx = this.d.artifacts.write(
      rendered.docx,
      "docx",
      "cover_letter_docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const ok = rendered.checks.every((c) => c.ok);
    const rec = this.d.coverLetters.create({
      letter,
      status: ok ? "draft" : "needs_attention",
      text: coverLetterText(letter),
      artifactIds: { html: html.id, pdf: pdf.id, docx: docx.id },
      checks: rendered.checks,
    });
    this.d.audit.append({
      ...event(
        traceId,
        app.id,
        app.jobId,
        "cover_letter.drafted",
        { letterId: letter.id, mode, dropped: dropped.length, status: rec.status },
        "system",
      ),
      artifactHashes: [html.sha256, pdf.sha256, docx.sha256],
    });
    return rec;
  }

  /** Validates each segment; a failing one gets one revision, then is dropped with its reason. */
  private async verifySegments(
    segments: readonly DraftSegment[],
    facts: readonly VerifiedFact[],
    job: Job,
    budget: RunBudget,
    traceId: string,
    dropped: { text: string; sourceFactIds: string[]; reason: string }[],
  ): Promise<{ kept: DraftSegment[]; revisions: number }> {
    const byId = new Map(facts.map((f) => [f.id, f]));
    const posting = `${job.title} ${job.company} ${job.descriptionText}`;
    const check = (s: DraftSegment) =>
      s.kind === "fact"
        ? validateBullet(
            {
              text: s.text,
              sourceFactIds: s.factIds,
              transformation: s.transformation ?? "rephrase",
            },
            { facts: byId },
          )
        : validateMotivation(s.text, posting);
    const kept: DraftSegment[] = [];
    let revisions = 0;
    for (const s0 of segments) {
      let s = s0;
      let findings = check(s);
      if (findings.length && this.d.drafter) {
        try {
          revisions++;
          const r = await this.d.drafter.reviseSegment(
            {
              segment: s,
              problems: problemText(findings),
              facts: s.factIds
                .map((id) => byId.get(id))
                .filter((f): f is VerifiedFact => !!f)
                .map(asGeneratorFact),
              postingExcerpt: posting.slice(0, 3000),
            },
            { budget, traceId },
          );
          r.runs.forEach((x) => {
            this.d.providerRuns.record(x);
          });
          if (r.revised) {
            s = r.revised;
            findings = check(s);
          }
        } catch {
          // Keep the failing findings; the segment is dropped below.
        }
      }
      if (findings.length)
        dropped.push({
          text: s0.text,
          sourceFactIds: s0.factIds,
          reason: problemText(findings).join(" "),
        });
      else kept.push(s);
    }
    return { kept, revisions };
  }

  private plannerContext(
    ownerId: string,
    app: Application,
    drafts: ReadonlyMap<string, { text: string; factIds: string[] }>,
  ): PlannerContext {
    const resume = app.resumeVersionId ? this.d.resumes.get(app.resumeVersionId) : null;
    const letter = app.coverLetterVersionId
      ? this.d.coverLetters.get(app.coverLetterVersionId)
      : null;
    return {
      profile: this.d.profiles.get(ownerId),
      savedAnswers: this.d.savedAnswers.listActive(ownerId),
      facts: matchableFacts(this.d.facts.listActive(ownerId)),
      approvedResume:
        resume?.status === "approved" && resume.artifacts.pdf
          ? { pdfArtifactId: resume.artifacts.pdf.id }
          : null,
      approvedCoverLetter:
        letter?.status === "approved" && letter.artifacts.pdf
          ? { pdfArtifactId: letter.artifacts.pdf.id, text: letter.text }
          : null,
      drafts,
    };
  }

  /**
   * Re-plans system answers whose inputs changed and walks the state machine: forward to PREPARING, between
   * PREPARING and AWAITING_USER_INPUT, and back from READY_FOR_REVIEW when the owner changes something (`reopen`).
   */
  private afterChange(
    ownerId: string,
    applicationId: string,
    traceId: string,
    reopen = false,
  ): ApplicationOverview {
    let app = this.owned(ownerId, applicationId);
    const ctx = this.plannerContext(ownerId, app, new Map());
    for (const a of this.d.fields.list(app.id)) {
      if (a.finalValueSetBy === "user" || a.provenance.kind === "draft") continue;
      const planned = planAnswer(a.field, ctx);
      if (JSON.stringify(planned) !== JSON.stringify(a)) this.d.fields.saveAnswer(app.id, planned);
    }
    const o = this.overview(ownerId, app.id);
    const step = (to: ApplicationState, extra: { artifactsVerified?: boolean } = {}) => {
      assertApplicationTransition(app.state, to, {
        actor: "system",
        mode: "review-each",
        ...extra,
      });
      app = this.d.applications.transition(app.id, to, {
        actor: "system",
        mode: "review-each",
        traceId,
        ...extra,
      });
    };
    const idx = (s: ApplicationState) => FORWARD.indexOf(s);
    if (o.materialsReady && idx(app.state) >= 0 && idx(app.state) < idx("READY_TO_PREPARE")) {
      while (app.state !== "READY_TO_PREPARE")
        step(FORWARD[idx(app.state) + 1] as ApplicationState, { artifactsVerified: true });
    }
    const hasQuestions = o.answers.length > 0;
    if (app.state === "READY_TO_PREPARE" && hasQuestions) step("PREPARING");
    // Only required questions hold the application; optional ones can stay blank.
    const waiting = o.pending.some((a) => a.field.required);
    // Anything changed after the form was prepared sends it back for another pass (and a fresh review).
    if (app.state === "READY_FOR_REVIEW" && (reopen || waiting || !o.answersComplete))
      step("PREPARING");
    if (app.state === "PREPARING" && waiting) step("AWAITING_USER_INPUT");
    else if (app.state === "AWAITING_USER_INPUT" && !waiting) step("PREPARING");
    return { ...o, application: app };
  }

  private owned(ownerId: string, applicationId: string): Application {
    const app = this.d.applications.get(applicationId);
    if (!app || app.userId !== ownerId) throw new NotFoundError("Application not found.");
    return app;
  }

  private job(app: Application): Job {
    const job = this.d.jobs.get(app.jobId);
    if (!job) throw new NotFoundError("Job not found.");
    return job;
  }

  private allFacts(ownerId: string, ids: readonly string[]): VerifiedFact[] {
    const active = this.d.facts.listActive(ownerId);
    const extra = [...new Set(ids)]
      .filter((id) => !active.some((f) => f.id === id))
      .map((id) => this.d.facts.get(id))
      .filter((f): f is VerifiedFact => !!f);
    return [...active, ...extra];
  }
}
