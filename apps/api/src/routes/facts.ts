import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  FactCategory,
  FactTransformation,
  ValidationError,
  type FactBankService,
} from "@career-agent/domain";
import type { Store } from "@career-agent/db";
import { sha256Hex } from "@career-agent/security";
import { parseBody } from "../http-errors.js";
import { idempotent } from "../idempotency.js";
import type { LocalGuard } from "../local-guard.js";

const IdParams = z.object({ id: z.uuidv7() });
const Edits = z.object({
  claim: z.string().trim().min(1).max(1000).optional(),
  category: FactCategory.optional(),
  sensitive: z.boolean().optional(),
  allowedTransformations: z.array(FactTransformation).min(1).optional(),
});
const NewFact = Edits.extend({ claim: z.string().trim().min(1).max(1000), category: FactCategory });
const Correction = Edits.extend({ claim: z.string().trim().min(1).max(1000) });

/** Drops undefined keys so optional fields satisfy exactOptionalPropertyTypes. */
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

export function registerFactRoutes(
  app: FastifyInstance,
  d: { guard: LocalGuard; store: Store; ownerId: string; factBank: FactBankService },
) {
  app.post(
    "/api/v1/resumes",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      d.guard.requireSession(req);
      const file = await req.file();
      if (!file) throw new ValidationError("Attach a résumé file.");
      const buf = await file.toBuffer();
      const fingerprint = { sha: sha256Hex(buf) };
      return idempotent(d.store.idempotency, req, reply, fingerprint, async () => {
        const result = await d.factBank.importResume(d.ownerId, buf, req.ctx.traceId);
        return { statusCode: result.alreadyImported ? 200 : 201, body: result };
      });
    },
  );

  app.get("/api/v1/fact-candidates", (req) => {
    d.guard.requireSession(req);
    return { candidates: d.factBank.listCandidates(d.ownerId) };
  });

  app.post("/api/v1/fact-candidates/:id/confirm", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const edits = defined(parseBody(Edits, req.body ?? {}));
    return idempotent(d.store.idempotency, req, reply, edits, () => ({
      statusCode: 201,
      body: { fact: d.factBank.confirmCandidate(d.ownerId, id, edits, req.ctx.traceId) },
    }));
  });

  app.post("/api/v1/fact-candidates/:id/reject", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    return idempotent(d.store.idempotency, req, reply, null, () => {
      d.factBank.rejectCandidate(d.ownerId, id, req.ctx.traceId);
      return { statusCode: 200, body: { rejected: id } };
    });
  });

  app.get("/api/v1/facts", (req) => {
    d.guard.requireSession(req);
    return { facts: d.factBank.listFacts(d.ownerId) };
  });

  app.post("/api/v1/facts", (req, reply) => {
    d.guard.requireSession(req);
    const body = defined(parseBody(NewFact, req.body));
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 201,
      body: { fact: d.factBank.addFact(d.ownerId, body, req.ctx.traceId) },
    }));
  });

  app.post("/api/v1/facts/:id/corrections", (req, reply) => {
    d.guard.requireSession(req);
    const { id } = parseBody(IdParams, req.params);
    const body = defined(parseBody(Correction, req.body));
    return idempotent(d.store.idempotency, req, reply, body, () => ({
      statusCode: 201,
      body: { fact: d.factBank.correctFact(d.ownerId, id, body, req.ctx.traceId) },
    }));
  });
}
