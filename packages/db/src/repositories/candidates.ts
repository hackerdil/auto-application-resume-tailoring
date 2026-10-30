import { and, asc, eq } from "drizzle-orm";
import {
  ConflictError,
  FactCandidate,
  NotFoundError,
  PolicyError,
  uuidv7,
  type CandidateRepository,
  type CandidateStatus,
  type DocumentTextRepository,
  type NewFactCandidate,
} from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { documentTexts, factCandidates } from "../schema.js";
import { toIso, toIsoOrNull, type Clock } from "../time.js";

type Row = typeof factCandidates.$inferSelect;

export class SqliteCandidateRepository implements CandidateRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  addMany(
    userId: string,
    artifactId: string,
    candidates: readonly NewFactCandidate[],
  ): FactCandidate[] {
    const cipher = requireCipher(this.cipher);
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        return candidates.map((c) => {
          const id = uuidv7();
          const row: Row = {
            id,
            userId,
            artifactId,
            category: c.category,
            claimEnc: cipher.encrypt(c.claim, `fact_candidates.claim:${id}`),
            evidenceEnc: cipher.encrypt(c.evidenceText, `fact_candidates.evidence:${id}`),
            sourceLocation: c.sourceLocation,
            extractor: c.extractor,
            sensitive: c.sensitive,
            status: "pending",
            factId: null,
            createdAt: now,
            decidedAt: null,
          };
          tx.insert(factCandidates).values(row).run();
          return this.toDomain(row);
        });
      },
      { behavior: "immediate" },
    );
  }

  get(id: string): FactCandidate | null {
    const row = this.db.select().from(factCandidates).where(eq(factCandidates.id, id)).get();
    return row ? this.toDomain(row) : null;
  }

  list(userId: string, status?: CandidateStatus): FactCandidate[] {
    const where = status
      ? and(eq(factCandidates.userId, userId), eq(factCandidates.status, status))
      : eq(factCandidates.userId, userId);
    return this.db
      .select()
      .from(factCandidates)
      .where(where)
      .orderBy(asc(factCandidates.id))
      .all()
      .map((r) => this.toDomain(r));
  }

  decide(
    id: string,
    decision: { status: "confirmed"; factId: string } | { status: "rejected" },
  ): FactCandidate {
    const now = this.now();
    const res = this.db
      .update(factCandidates)
      .set({
        status: decision.status,
        factId: decision.status === "confirmed" ? decision.factId : null,
        decidedAt: now,
      })
      .where(and(eq(factCandidates.id, id), eq(factCandidates.status, "pending")))
      .run();
    if (res.changes !== 1) {
      if (!this.get(id)) throw new NotFoundError("Candidate not found.");
      throw new ConflictError("This suggestion was already confirmed or rejected.");
    }
    const updated = this.get(id);
    if (!updated) throw new NotFoundError("Candidate not found.");
    return updated;
  }

  private toDomain(r: Row): FactCandidate {
    const cipher = requireCipher(this.cipher);
    return FactCandidate.parse({
      id: r.id,
      userId: r.userId,
      artifactId: r.artifactId,
      category: r.category,
      claim: cipher.decrypt(r.claimEnc, `fact_candidates.claim:${r.id}`),
      evidenceText: cipher.decrypt(r.evidenceEnc, `fact_candidates.evidence:${r.id}`),
      sourceLocation: r.sourceLocation,
      extractor: r.extractor,
      sensitive: r.sensitive,
      status: r.status,
      factId: r.factId,
      createdAt: toIso(r.createdAt),
      decidedAt: toIsoOrNull(r.decidedAt),
    });
  }
}

export class SqliteDocumentTextRepository implements DocumentTextRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  put(artifactId: string, text: string): void {
    const cipher = requireCipher(this.cipher);
    this.db
      .insert(documentTexts)
      .values({
        artifactId,
        textEnc: cipher.encrypt(text, `document_texts.text:${artifactId}`),
        createdAt: this.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  get(artifactId: string): string | null {
    const row = this.db
      .select()
      .from(documentTexts)
      .where(eq(documentTexts.artifactId, artifactId))
      .get();
    return row
      ? requireCipher(this.cipher).decrypt(row.textEnc, `document_texts.text:${artifactId}`)
      : null;
  }
}

function requireCipher(cipher: FieldCipher | null): FieldCipher {
  if (!cipher)
    throw new PolicyError("Imported documents require an encryption key (DATA_ENCRYPTION_KEY).");
  return cipher;
}
