import { desc, eq } from "drizzle-orm";
import {
  ConflictError,
  NotFoundError,
  TailoredResume,
  type ResumeStatus,
  type ResumeVersionRecord,
  type ResumeVersionRepository,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { artifacts, resumeBullets, resumeVersions } from "../schema.js";
import { fromIso, toIso, toIsoOrNull, type Clock } from "../time.js";

export const CLASSIC_TEMPLATE_ID = "0190f0b0-0000-7000-8000-00000000c001";

type Row = typeof resumeVersions.$inferSelect;

export class SqliteResumeVersionRepository implements ResumeVersionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(input: Parameters<ResumeVersionRepository["create"]>[0]): ResumeVersionRecord {
    const r = TailoredResume.parse(input.resume);
    this.db.transaction(
      (tx) => {
        tx.insert(resumeVersions)
          .values({
            id: r.id,
            jobId: r.jobId,
            profileVersion: r.profileVersion,
            templateId: CLASSIC_TEMPLATE_ID,
            structured: r,
            status: input.status,
            length: r.length,
            htmlArtifactId: input.artifactIds.html,
            pdfArtifactId: input.artifactIds.pdf,
            docxArtifactId: input.artifactIds.docx,
            checks: input.checks,
            createdAt: fromIso(r.createdAt),
          })
          .run();
        let ordinal = 0;
        for (const e of r.experience) {
          for (const b of e.bullets) {
            tx.insert(resumeBullets)
              .values({
                id: b.id,
                resumeVersionId: r.id,
                ordinal: ordinal++,
                text: b.text,
                sourceFactIds: b.sourceFactIds,
                targetRequirementKeys: b.targetRequirementKeys,
                transformation: b.transformation,
                deterministicStatus: b.verifier.deterministic,
                reviewStatus: b.verifier.review,
                findings: b.verifier.findings,
              })
              .run();
          }
        }
      },
      { behavior: "immediate" },
    );
    const rec = this.get(r.id);
    if (!rec) throw new NotFoundError("Résumé version not found after insert.");
    return rec;
  }

  get(id: string): ResumeVersionRecord | null {
    const row = this.db.select().from(resumeVersions).where(eq(resumeVersions.id, id)).get();
    return row ? this.toRecord(row) : null;
  }

  listForJob(jobId: string): ResumeVersionRecord[] {
    return this.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.jobId, jobId))
      .orderBy(desc(resumeVersions.createdAt), desc(resumeVersions.id))
      .all()
      .map((r) => this.toRecord(r));
  }

  decide(id: string, status: "approved" | "rejected"): ResumeVersionRecord {
    const current = this.get(id);
    if (!current) throw new NotFoundError("Résumé version not found.");
    if (current.status !== "draft")
      throw new ConflictError(
        `This résumé is ${current.status.replace("_", " ")} and can no longer be ${status}.`,
      );
    this.db
      .update(resumeVersions)
      .set({ status, decidedAt: this.now() })
      .where(eq(resumeVersions.id, id))
      .run();
    const rec = this.get(id);
    if (!rec) throw new NotFoundError("Résumé version not found.");
    return rec;
  }

  private artifact(id: string | null) {
    if (!id) return null;
    const a = this.db
      .select({ id: artifacts.id, sha256: artifacts.sha256 })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .get();
    return a ?? null;
  }

  private toRecord(row: Row): ResumeVersionRecord {
    return {
      resume: TailoredResume.parse(row.structured),
      status: row.status as ResumeStatus,
      artifacts: {
        html: this.artifact(row.htmlArtifactId),
        pdf: this.artifact(row.pdfArtifactId),
        docx: this.artifact(row.docxArtifactId),
      },
      checks: row.checks as ResumeVersionRecord["checks"],
      createdAt: toIso(row.createdAt),
      decidedAt: toIsoOrNull(row.decidedAt),
    };
  }
}
