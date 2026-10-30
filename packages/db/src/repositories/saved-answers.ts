import { and, eq, isNull } from "drizzle-orm";
import { PolicyError, SavedAnswer, uuidv7, type SavedAnswerRepository } from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { mapConstraintError } from "../errors.js";
import { savedAnswers } from "../schema.js";
import { toIso, type Clock } from "../time.js";

/** Saved answers are always encrypted: they routinely hold salary, authorization, or demographic data. */
export class SqliteSavedAnswerRepository implements SavedAnswerRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  save(answer: Omit<SavedAnswer, "id" | "createdAt" | "revokedAt">): SavedAnswer {
    const cipher = this.requireCipher();
    const id = uuidv7();
    const createdAt = this.now();
    try {
      this.db
        .insert(savedAnswers)
        .values({
          id,
          userId: answer.userId,
          normalizedQuestion: answer.normalizedQuestion,
          valueEnc: cipher.encrypt(answer.value, `saved_answers.value:${id}`),
          sensitivity: answer.sensitivity,
          createdAt,
        })
        .run();
    } catch (err) {
      mapConstraintError(
        err,
        "An active saved answer already exists for this question; revoke it first.",
      );
    }
    return SavedAnswer.parse({ ...answer, id, createdAt: toIso(createdAt) });
  }

  findActive(userId: string, normalizedQuestion: string): SavedAnswer | null {
    const row = this.db
      .select()
      .from(savedAnswers)
      .where(
        and(
          eq(savedAnswers.userId, userId),
          eq(savedAnswers.normalizedQuestion, normalizedQuestion),
          isNull(savedAnswers.revokedAt),
        ),
      )
      .get();
    if (!row) return null;
    return SavedAnswer.parse({
      id: row.id,
      userId: row.userId,
      normalizedQuestion: row.normalizedQuestion,
      value: this.requireCipher().decrypt(row.valueEnc, `saved_answers.value:${row.id}`),
      sensitivity: row.sensitivity,
      createdAt: toIso(row.createdAt),
    });
  }

  listActive(userId: string): SavedAnswer[] {
    return this.db
      .select()
      .from(savedAnswers)
      .where(and(eq(savedAnswers.userId, userId), isNull(savedAnswers.revokedAt)))
      .orderBy(savedAnswers.id)
      .all()
      .map((row) =>
        SavedAnswer.parse({
          id: row.id,
          userId: row.userId,
          normalizedQuestion: row.normalizedQuestion,
          value: this.requireCipher().decrypt(row.valueEnc, `saved_answers.value:${row.id}`),
          sensitivity: row.sensitivity,
          createdAt: toIso(row.createdAt),
        }),
      );
  }

  revoke(id: string): void {
    this.db
      .update(savedAnswers)
      .set({ revokedAt: this.now() })
      .where(and(eq(savedAnswers.id, id), isNull(savedAnswers.revokedAt)))
      .run();
  }

  private requireCipher(): FieldCipher {
    if (!this.cipher)
      throw new PolicyError("Saved answers require an encryption key (DATA_ENCRYPTION_KEY).");
    return this.cipher;
  }
}
