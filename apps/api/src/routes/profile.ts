import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProfileDraft, Sensitivity, type ProfileService } from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const SaveAnswerBody = z.object({
  question: z.string().trim().min(1).max(500),
  value: z.string().max(10_000),
  sensitivity: Sensitivity,
});
const IdParams = z.object({ id: z.uuidv7() });

export function registerProfileRoutes(
  app: FastifyInstance,
  d: { guard: LocalGuard; store: Store; ownerId: string; profiles: ProfileService },
) {
  app.get("/api/v1/profile", (req) => {
    d.guard.requireSession(req);
    return { profile: d.profiles.get(d.ownerId) };
  });

  app.put("/api/v1/profile", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(ProfileDraft, req.body);
    return idempotent(d.store.idempotency, req, reply, req.body, () => ({
      statusCode: 200,
      body: { profile: d.profiles.save(d.ownerId, body, req.ctx.traceId) },
    }));
  });

  app.get("/api/v1/saved-answers", (req) => {
    d.guard.requireSession(req);
    return { savedAnswers: d.store.savedAnswers.listActive(d.ownerId) };
  });

  app.post("/api/v1/saved-answers", (req, reply) => {
    d.guard.requireSession(req);
    const body = parseBody(SaveAnswerBody, req.body);
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 201,
      body: { savedAnswer: d.profiles.saveAnswer(d.ownerId, body, req.ctx.traceId) },
    }));
  });

  app.post("/api/v1/saved-answers/:id/revoke", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => {
      d.profiles.revokeAnswer(d.ownerId, id, req.ctx.traceId);
      return { statusCode: 200, body: { revoked: id } };
    });
  });
}
