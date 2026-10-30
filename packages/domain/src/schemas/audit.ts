import { z } from "zod";
import { Actor, Id, IsoDateTime, Sha256Hex } from "./common.js";

export const AuditEvent = z.object({
  id: Id,
  at: IsoDateTime,
  traceId: z.string().min(1),
  runId: Id.nullable(),
  taskId: Id.nullable(),
  applicationId: Id.nullable(),
  jobId: z.string().nullable(),
  actor: Actor,
  type: z
    .string()
    .regex(/^[a-z]+(\.[a-z_]+)+$/, "expected dotted lowercase type, e.g. application.transition"),
  prevState: z.string().nullable(),
  newState: z.string().nullable(),
  approvalId: Id.nullable(),
  artifactHashes: z.array(Sha256Hex),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Already-redacted metadata. Never put prompts, answers, or page content here. */
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
