import { asc, eq } from "drizzle-orm";
import type { AuditEvent, AuditRepository, NewAuditEvent } from "@career-agent/domain";
import type { Db } from "../database.js";
import { auditEvents } from "../schema.js";
import { toIso, type Clock } from "../time.js";
import { insertAudit } from "./shared.js";

export class SqliteAuditRepository implements AuditRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  append(event: NewAuditEvent): AuditEvent {
    return insertAudit(this.db, event, this.now);
  }

  listForApplication(applicationId: string): AuditEvent[] {
    return this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.applicationId, applicationId))
      .orderBy(asc(auditEvents.at), asc(auditEvents.id))
      .all()
      .map((r) => ({ ...r, at: toIso(r.at), actor: r.actor as AuditEvent["actor"] }));
  }
}
