import { desc, eq } from "drizzle-orm";
import {
  ConflictError,
  CoverLetter,
  NotFoundError,
  type CoverLetterRecord,
  type CoverLetterRepository,
  type CoverLetterStatus,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { artifacts, coverLetterVersions } from "../schema.js";
import { fromIso, toIso, toIsoOrNull, type Clock } from "../time.js";

type Row = typeof coverLetterVersions.$inferSelect;

export class SqliteCoverLetterRepository implements CoverLetterRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(input: Parameters<CoverLetterRepository["create"]>[0]): CoverLetterRecord {
    const l = CoverLetter.parse(input.letter);
    this.db
      .insert(coverLetterVersions)
      .values({
        id: l.id,
        applicationId: l.applicationId,
        jobId: l.jobId,
        structured: l,
        text: input.text,
        status: input.status,
        htmlArtifactId: input.artifactIds.html,
        pdfArtifactId: input.artifactIds.pdf,
        docxArtifactId: input.artifactIds.docx,
        checks: input.checks,
        createdAt: fromIso(l.createdAt),
      })
      .run();
    const rec = this.get(l.id);
    if (!rec) throw new NotFoundError("Cover letter not found after insert.");
    return rec;
  }

  get(id: string): CoverLetterRecord | null {
    const row = this.db
      .select()
      .from(coverLetterVersions)
      .where(eq(coverLetterVersions.id, id))
      .get();
    return row ? this.toRecord(row) : null;
  }

  listForApplication(applicationId: string): CoverLetterRecord[] {
    return this.db
      .select()
      .from(coverLetterVersions)
      .where(eq(coverLetterVersions.applicationId, applicationId))
      .orderBy(desc(coverLetterVersions.createdAt), desc(coverLetterVersions.id))
      .all()
      .map((r) => this.toRecord(r));
  }

  decide(id: string, status: "approved" | "rejected"): CoverLetterRecord {
    const cur = this.get(id);
    if (!cur) throw new NotFoundError("Cover letter not found.");
    if (cur.status !== "draft")
      throw new ConflictError(
        `This cover letter is ${cur.status.replace("_", " ")} and can no longer be ${status}.`,
      );
    this.db
      .update(coverLetterVersions)
      .set({ status, decidedAt: this.now() })
      .where(eq(coverLetterVersions.id, id))
      .run();
    const rec = this.get(id);
    if (!rec) throw new NotFoundError("Cover letter not found.");
    return rec;
  }

  private artifact(id: string | null) {
    if (!id) return null;
    return (
      this.db
        .select({ id: artifacts.id, sha256: artifacts.sha256 })
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .get() ?? null
    );
  }

  private toRecord(r: Row): CoverLetterRecord {
    return {
      letter: CoverLetter.parse(r.structured),
      status: r.status as CoverLetterStatus,
      text: r.text,
      artifacts: {
        html: this.artifact(r.htmlArtifactId),
        pdf: this.artifact(r.pdfArtifactId),
        docx: this.artifact(r.docxArtifactId),
      },
      checks: r.checks as CoverLetterRecord["checks"],
      createdAt: toIso(r.createdAt),
      decidedAt: toIsoOrNull(r.decidedAt),
    };
  }
}
