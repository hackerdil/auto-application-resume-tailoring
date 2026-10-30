import { uuidv7, type AuditEvent, type NewAuditEvent } from "@career-agent/domain";
import type { Db } from "../database.js";
import { auditEvents } from "../schema.js";
import { toIso, type Clock } from "../time.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

/** Inserts an audit event using the given executor, so callers can include it in their transaction. */
export function insertAudit(ex: Executor, event: NewAuditEvent, now: Clock): AuditEvent {
  const id = uuidv7();
  const at = now();
  ex.insert(auditEvents)
    .values({
      id,
      at,
      traceId: event.traceId,
      runId: event.runId,
      taskId: event.taskId,
      applicationId: event.applicationId,
      jobId: event.jobId,
      actor: event.actor,
      type: event.type,
      prevState: event.prevState,
      newState: event.newState,
      approvalId: event.approvalId,
      artifactHashes: event.artifactHashes,
      provider: event.provider,
      model: event.model,
      durationMs: event.durationMs,
      metadata: event.metadata,
    })
    .run();
  return { ...event, id, at: toIso(at) };
}

export const emptyAudit = {
  runId: null,
  taskId: null,
  applicationId: null,
  jobId: null,
  prevState: null,
  newState: null,
  approvalId: null,
  artifactHashes: [],
  provider: null,
  model: null,
  durationMs: null,
  metadata: {},
} satisfies Partial<NewAuditEvent>;
