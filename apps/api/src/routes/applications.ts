import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  browserKeyPrefix,
  CLOSE_BROWSER_TASK,
  COMMON_QUESTIONS,
  coverLetterKeyPrefix,
  PREPARE_APPLICATION_TASK,
  PolicyError,
  DRAFT_COVER_LETTER_TASK,
  FieldType,
  type ApplicationOverview,
  type ApplicationService,
} from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const IdParams = z.object({ id: z.uuidv7() });
const FieldParams = z.object({ id: z.uuidv7(), fieldId: z.uuidv7() });
const LetterParams = z.object({ id: z.uuidv7(), letterId: z.uuidv7() });
const IdQuery = z.object({ id: z.uuidv7() });
const CreateBody = z.object({ jobId: z.string().min(3).max(400) });
const ResumeBody = z.object({ resumeVersionId: z.uuidv7() });
const SkipBody = z.object({ skip: z.boolean() });
const QuestionsBody = z.union([
  z.object({ common: z.literal(true) }),
  z.object({
    questions: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(500),
          type: FieldType.default("text"),
          required: z.boolean().default(false),
          options: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
        }),
      )
      .min(1)
      .max(50),
  }),
]);
const AnswerBody = z.union([
  z.object({ useProposal: z.literal(true) }),
  z.object({ value: z.string().max(10_000).nullable() }),
]);

const PREPARABLE = new Set([
  "READY_TO_PREPARE",
  "PREPARING",
  "AWAITING_USER_INPUT",
  "READY_FOR_REVIEW",
]);

function browserState(store: Store, applicationId: string) {
  const rec = store.browserSessions.latest(applicationId);
  const [message, ...checklist] = (rec?.handoffReason ?? "").split("\n").filter(Boolean);
  return {
    busy: store.tasks.hasActive(browserKeyPrefix(applicationId)),
    session: rec
      ? {
          status: rec.status,
          adapter: rec.adapter,
          steps: rec.steps,
          lastUrl: rec.lastUrl,
          message: message ?? null,
          checklist,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
        }
      : null,
  };
}

function present(o: ApplicationOverview, store: Store) {
  const claim = (id: string) => store.facts.get(id)?.claim ?? null;
  return {
    application: o.application,
    job: {
      id: o.job.id,
      title: o.job.title,
      company: o.job.company,
      status: o.job.status,
      sourceUrl: o.job.sourceUrl,
    },
    answers: o.answers.map((a) => ({
      ...a,
      // Show the owner exactly which facts an answer relies on.
      sources:
        a.provenance.kind === "facts" || a.provenance.kind === "draft"
          ? a.provenance.factIds.map((id) => ({ id, claim: claim(id) }))
          : [],
    })),
    pending: o.pending.map((a) => a.field.id),
    answersComplete: o.answersComplete,
    consistency: o.consistency,
    materialsReady: o.materialsReady,
  };
}

export function registerApplicationRoutes(
  app: FastifyInstance,
  d: { guard: LocalGuard; store: Store; ownerId: string; applications: ApplicationService },
) {
  app.get("/api/v1/applications", (req) => {
    d.guard.requireSession(req);
    return {
      applications: d.store.applications.list(d.ownerId).map((a) => {
        const job = d.store.jobs.get(a.jobId);
        const o = d.applications.overview(d.ownerId, a.id);
        return {
          id: a.id,
          state: a.state,
          updatedAt: a.updatedAt,
          job: job ? { id: job.id, title: job.title, company: job.company } : null,
          pending: o.pending.length,
          answersComplete: o.answersComplete,
        };
      }),
    };
  });

  app.post("/api/v1/applications", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(CreateBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => {
      const a = d.applications.create(d.ownerId, body.jobId, req.ctx.traceId);
      return { statusCode: 201, body: { application: a } };
    });
  });

  app.get("/api/v1/applications/detail", (req) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdQuery, req.query);
    const o = d.applications.overview(d.ownerId, id);
    const resumes = d.store.resumes.listForJob(o.job.id).map((r) => ({
      id: r.resume.id,
      status: r.status,
      length: r.resume.length,
      createdAt: r.createdAt,
    }));
    const coverLetters = d.store.coverLetters.listForApplication(id).map((c) => ({
      id: c.letter.id,
      status: c.status,
      createdAt: c.createdAt,
      text: c.text,
      mode: c.letter.meta.mode,
      notes: c.letter.meta.notes,
      segments: c.letter.paragraphs.flat().map((s) => ({
        kind: s.kind,
        text: s.text,
        sources: s.factIds.map((fid) => d.store.facts.get(fid)?.claim ?? null),
      })),
      dropped: c.letter.dropped,
      checks: c.checks,
      artifacts: c.artifacts,
    }));
    return {
      ...present(o, d.store),
      resumes,
      coverLetters,
      coverLetterDrafting: d.store.tasks.hasActive(coverLetterKeyPrefix(id)),
      browser: browserState(d.store, id),
    };
  });

  // Phase 7: the worker opens a visible browser and prepares the form; it never submits.
  app.post("/api/v1/applications/:id/browser/prepare", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => {
      const o = d.applications.overview(d.ownerId, id);
      if (!PREPARABLE.has(o.application.state))
        throw new PolicyError(
          "Approve a résumé and choose or skip a cover letter before preparing the form.",
        );
      if (d.store.tasks.hasActive(browserKeyPrefix(id)))
        return { statusCode: 202, body: { queued: false, alreadyRunning: true } };
      const t = d.store.tasks.enqueue(
        PREPARE_APPLICATION_TASK,
        { applicationId: id, traceId: req.ctx.traceId },
        `${browserKeyPrefix(id)}prepare:${req.ctx.traceId}`,
      );
      return { statusCode: 202, body: { queued: true, taskId: t.id } };
    });
  });

  app.post("/api/v1/applications/:id/browser/close", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => {
      d.applications.overview(d.ownerId, id); // ownership check
      const t = d.store.tasks.enqueue(
        CLOSE_BROWSER_TASK,
        { applicationId: id, traceId: req.ctx.traceId },
        `${browserKeyPrefix(id)}close:${req.ctx.traceId}`,
      );
      return { statusCode: 202, body: { queued: true, taskId: t.id } };
    });
  });

  app.post("/api/v1/applications/:id/resume", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const body = parseBody(ResumeBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 200,
      body: present(
        d.applications.selectResume(d.ownerId, id, body.resumeVersionId, req.ctx.traceId),
        d.store,
      ),
    }));
  });

  app.post("/api/v1/applications/:id/cover-letter/skip", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const body = parseBody(SkipBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 200,
      body: present(
        d.applications.skipCoverLetter(d.ownerId, id, body.skip, req.ctx.traceId),
        d.store,
      ),
    }));
  });

  app.post("/api/v1/applications/:id/cover-letter/draft", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => {
      d.applications.overview(d.ownerId, id); // ownership check
      if (d.store.tasks.hasActive(coverLetterKeyPrefix(id)))
        return { statusCode: 202, body: { queued: false, alreadyRunning: true } };
      const t = d.store.tasks.enqueue(
        DRAFT_COVER_LETTER_TASK,
        { applicationId: id, traceId: req.ctx.traceId },
        `${coverLetterKeyPrefix(id)}${req.ctx.traceId}`,
      );
      return { statusCode: 202, body: { queued: true, taskId: t.id } };
    });
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/api/v1/applications/:id/cover-letters/:letterId/${decision}`, (req, reply) => {
      d.guard.requireSession(req);
      const { id, letterId } = parseBody(LetterParams, req.params);
      return idempotent(d.store.idempotency, req, reply, null, () => ({
        statusCode: 200,
        body: present(
          d.applications.decideCoverLetter(
            d.ownerId,
            id,
            letterId,
            decision === "approve" ? "approved" : "rejected",
            req.ctx.traceId,
          ),
          d.store,
        ),
      }));
    });
  }

  app.post("/api/v1/applications/:id/questions", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const body = parseBody(QuestionsBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => {
      const o =
        "common" in body
          ? d.applications.addQuestions(d.ownerId, id, COMMON_QUESTIONS, "common", req.ctx.traceId)
          : d.applications.addQuestions(d.ownerId, id, body.questions, "manual", req.ctx.traceId);
      return { statusCode: 200, body: present(o, d.store) };
    });
  });

  app.post("/api/v1/applications/:id/questions/:fieldId/answer", (req, reply) => {
    d.guard.requireSession(req);
    const { id, fieldId } = parseBody(FieldParams, req.params);
    const body = parseBody(AnswerBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 200,
      body: present(d.applications.answer(d.ownerId, id, fieldId, body, req.ctx.traceId), d.store),
    }));
  });

  app.post("/api/v1/applications/:id/questions/:fieldId/remove", (req, reply) => {
    d.guard.requireSession(req);
    const { id, fieldId } = parseBody(FieldParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => ({
      statusCode: 200,
      body: present(
        d.applications.removeQuestion(d.ownerId, id, fieldId, req.ctx.traceId),
        d.store,
      ),
    }));
  });

  app.post("/api/v1/applications/:id/draft-answers", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, async () => {
      const r = await d.applications.draftAnswers(d.ownerId, id, req.ctx.traceId);
      return {
        statusCode: 200,
        body: {
          ...present(r.overview, d.store),
          drafted: r.drafted,
          dropped: r.dropped,
          note: r.note,
        },
      };
    });
  });

  app.post("/api/v1/applications/:id/replan", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => ({
      statusCode: 200,
      body: present(d.applications.replan(d.ownerId, id, req.ctx.traceId), d.store),
    }));
  });
}
