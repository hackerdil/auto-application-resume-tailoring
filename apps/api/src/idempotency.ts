import type { FastifyReply, FastifyRequest } from "fastify";
import type { IdempotencyRepository } from "@career-agent/domain";
import { canonicalJson, sha256Hex } from "@career-agent/security";
import { HttpError } from "./http-errors.js";

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Executes a mutating handler at most once per Idempotency-Key (spec §18). A retried request with the same key
 * and body gets the stored response; the same key with a different body is a 409.
 */
export async function idempotent(
  repo: IdempotencyRepository,
  req: FastifyRequest,
  reply: FastifyReply,
  requestFingerprint: unknown,
  handler: () =>
    Promise<{ statusCode: number; body: unknown }> | { statusCode: number; body: unknown },
): Promise<unknown> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Mutating requests need an Idempotency-Key header (8–128 characters).",
    );
  }
  const scope = `${req.method} ${req.routeOptions.url ?? req.url}`;
  const requestHash = sha256Hex(
    canonicalJson({ params: req.params ?? null, body: requestFingerprint ?? null }),
  );
  const stored = repo.lookup(key, scope, requestHash);
  if (stored) {
    void reply.header("idempotent-replay", "true").code(stored.statusCode);
    return stored.body;
  }
  const result = await handler();
  if (result.statusCode < 300) repo.save(key, scope, requestHash, result);
  void reply.code(result.statusCode);
  return result.body;
}
