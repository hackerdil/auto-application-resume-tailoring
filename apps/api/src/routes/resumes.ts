import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NotFoundError,
  PolicyError,
  ResumeLength,
  TAILOR_RESUME_TASK,
  tailorKeyPrefix,
  wordDiff,
  type ResumeVersionRecord,
  type TailoringService,
} from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import type { FileArtifactStore } from "@career-agent/documents";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const TailorBody = z.object({
  jobId: z.string().min(3).max(400),
  length: ResumeLength.default("one-page"),
});
const JobQuery = z.object({ jobId: z.string().min(3).max(400) });
const IdQuery = z.object({ id: z.uuidv7() });
const IdParams = z.object({ id: z.uuidv7() });

/** Only rendered résumés and cover letters are downloadable; source uploads and other files are not served. */
const DOWNLOADABLE: Record<string, { ext: string; type: string }> = {
  resume_pdf: { ext: "pdf", type: "application/pdf" },
  resume_docx: {
    ext: "docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  resume_html: { ext: "html", type: "text/html; charset=utf-8" },
  cover_letter_pdf: { ext: "pdf", type: "application/pdf" },
  cover_letter_docx: {
    ext: "docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  cover_letter_html: { ext: "html", type: "text/html; charset=utf-8" },
};

const summary = (r: ResumeVersionRecord) => ({
  id: r.resume.id,
  jobId: r.resume.jobId,
  status: r.status,
  length: r.resume.length,
  mode: r.resume.meta.mode,
  createdAt: r.createdAt,
  bullets: r.resume.experience.reduce((a, e) => a + e.bullets.length, 0),
  dropped: r.resume.dropped.length,
  failedChecks: r.checks.filter((c) => !c.ok).map((c) => c.name),
  artifacts: r.artifacts,
});

export function registerResumeRoutes(
  app: FastifyInstance,
  d: {
    guard: LocalGuard;
    store: Store;
    ownerId: string;
    tailoring: TailoringService;
    files: FileArtifactStore;
  },
) {
  app.post("/api/v1/tailored-resumes", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(TailorBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => {
      const job = d.store.jobs.get(body.jobId);
      if (!job) throw new NotFoundError("Job not found.");
      if (d.store.tasks.hasActive(tailorKeyPrefix(job.id)))
        return { statusCode: 202, body: { queued: false, alreadyRunning: true } };
      const t = d.store.tasks.enqueue(
        TAILOR_RESUME_TASK,
        { jobId: job.id, length: body.length, traceId: req.ctx.traceId },
        `${tailorKeyPrefix(job.id)}${req.ctx.traceId}`,
      );
      return { statusCode: 202, body: { queued: true, taskId: t.id } };
    });
  });

  app.get("/api/v1/tailored-resumes", (req) => {
    d.guard.requireSession(req);
    const { jobId } = parseBody(JobQuery, req.query);
    return {
      resumes: d.store.resumes.listForJob(jobId).map(summary),
      tailoring: d.store.tasks.hasActive(tailorKeyPrefix(jobId)),
    };
  });

  /** Full version with provenance: each bullet's source facts and a word diff against the original fact text. */
  app.get("/api/v1/tailored-resumes/detail", (req) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdQuery, req.query);
    const rec = d.store.resumes.get(id);
    if (!rec) throw new NotFoundError("Résumé not found.");
    const claim = (fid: string) => d.store.facts.get(fid)?.claim ?? null;
    const provenance = rec.resume.experience.flatMap((e) =>
      e.bullets.map((b) => {
        const sources = b.sourceFactIds.map((fid) => ({ id: fid, claim: claim(fid) }));
        const original = sources.map((s) => s.claim ?? "").join(" ");
        return {
          bulletId: b.id,
          transformation: b.transformation,
          sources,
          diff:
            b.transformation === "select" || b.transformation === "reorder"
              ? null
              : wordDiff(original, b.text),
        };
      }),
    );
    const omitted = rec.resume.omittedFactIds.map((fid) => ({ id: fid, claim: claim(fid) }));
    return {
      ...summary(rec),
      resume: rec.resume,
      checks: rec.checks,
      provenance,
      omitted,
      decidedAt: rec.decidedAt,
    };
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/api/v1/tailored-resumes/:id/${decision}`, (req, reply) => {
      d.guard.requireSession(req);
      const { id } = parseBody(IdParams, req.params);
      return idempotent(d.store.idempotency, req, reply, null, () => ({
        statusCode: 200,
        body: summary(
          d.tailoring.decide(id, decision === "approve" ? "approved" : "rejected", req.ctx.traceId),
        ),
      }));
    });
  }

  app.get("/api/v1/artifacts/:id/download", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const a = d.store.artifacts.get(id);
    if (!a) throw new NotFoundError("File not found.");
    const kind = DOWNLOADABLE[a.kind];
    if (!kind) throw new PolicyError("This file cannot be downloaded.");
    const data = d.files.read(a.storagePath, a.sha256);
    // Always an attachment (never rendered inside the app's origin), with a generated file name.
    void reply
      .header("content-type", kind.type)
      .header(
        "content-disposition",
        `attachment; filename="${a.kind.startsWith("cover_letter") ? "cover-letter" : "resume"}-${a.sha256.slice(0, 12)}.${kind.ext}"`,
      )
      .header("x-content-type-options", "nosniff");
    return reply.send(data);
  });
}
