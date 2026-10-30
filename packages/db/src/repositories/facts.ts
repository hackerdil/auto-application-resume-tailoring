import { and, eq, isNull } from "drizzle-orm";
import {
  NewVerifiedFact,
  NotFoundError,
  PolicyError,
  uuidv7,
  VerifiedFact,
  type FactRepository,
} from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { facts } from "../schema.js";
import { fromIso, toIso, type Clock } from "../time.js";
import type { Executor } from "./shared.js";

type Row = typeof facts.$inferSelect;

export class SqliteFactRepository implements FactRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  add(userId: string, fact: NewVerifiedFact): VerifiedFact {
    return this.insert(this.db, userId, NewVerifiedFact.parse(fact));
  }

  supersede(userId: string, factId: string, replacement: NewVerifiedFact): VerifiedFact {
    const parsed = NewVerifiedFact.parse(replacement);
    return this.db.transaction(
      (tx) => {
        const old = tx
          .select()
          .from(facts)
          .where(and(eq(facts.id, factId), eq(facts.userId, userId)))
          .get();
        if (!old) throw new NotFoundError("Fact not found.");
        if (old.supersededBy)
          throw new PolicyError("Fact was already superseded; correct the newest version.");
        const created = this.insert(tx, userId, parsed);
        tx.update(facts).set({ supersededBy: created.id }).where(eq(facts.id, factId)).run();
        return created;
      },
      { behavior: "immediate" },
    );
  }

  get(factId: string): VerifiedFact | null {
    const row = this.db.select().from(facts).where(eq(facts.id, factId)).get();
    return row ? this.toDomain(row) : null;
  }

  listActive(userId: string): VerifiedFact[] {
    return this.db
      .select()
      .from(facts)
      .where(and(eq(facts.userId, userId), isNull(facts.supersededBy)))
      .orderBy(facts.id)
      .all()
      .map((r) => this.toDomain(r));
  }

  private insert(ex: Executor, userId: string, f: NewVerifiedFact): VerifiedFact {
    const id = uuidv7();
    ex.insert(facts)
      .values({
        id,
        userId,
        category: f.category,
        claim: this.seal(f.claim, f.sensitive, `facts.claim:${id}`),
        source: f.source,
        sourceArtifactId: f.sourceArtifactId ?? null,
        sourceLocation: f.sourceLocation ?? null,
        evidenceText:
          f.evidenceText === undefined
            ? null
            : this.seal(f.evidenceText, f.sensitive, `facts.evidence_text:${id}`),
        verifiedAt: fromIso(f.verifiedAt),
        allowedTransformations: f.allowedTransformations,
        sensitive: f.sensitive,
        createdAt: this.now(),
      })
      .run();
    return VerifiedFact.parse({ ...f, id });
  }

  private seal(value: string, sensitive: boolean, aad: string): string {
    if (!sensitive) return value;
    if (!this.cipher)
      throw new PolicyError("Sensitive facts require an encryption key (DATA_ENCRYPTION_KEY).");
    return this.cipher.encrypt(value, aad);
  }

  private open(value: string, sensitive: boolean, aad: string): string {
    if (!sensitive) return value;
    if (!this.cipher) throw new PolicyError("Reading sensitive facts requires the encryption key.");
    return this.cipher.decrypt(value, aad);
  }

  private toDomain(r: Row): VerifiedFact {
    return VerifiedFact.parse({
      id: r.id,
      category: r.category,
      claim: this.open(r.claim, r.sensitive, `facts.claim:${r.id}`),
      source: r.source,
      ...(r.sourceArtifactId ? { sourceArtifactId: r.sourceArtifactId } : {}),
      ...(r.sourceLocation ? { sourceLocation: r.sourceLocation } : {}),
      ...(r.evidenceText !== null
        ? { evidenceText: this.open(r.evidenceText, r.sensitive, `facts.evidence_text:${r.id}`) }
        : {}),
      verifiedAt: toIso(r.verifiedAt),
      ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
      allowedTransformations: r.allowedTransformations,
      sensitive: r.sensitive,
    });
  }
}
