import { and, asc, eq } from "drizzle-orm";
import {
  ApplicationAnswer,
  NotFoundError,
  PolicyError,
  uuidv7,
  type ApplicationFieldRepository,
} from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { applicationAnswers, applicationFields } from "../schema.js";
import type { Clock } from "../time.js";
import type { Executor } from "./shared.js";

/** Fields are immutable; answers are replaced as a whole. Proposed and final values are encrypted per field. */
export class SqliteApplicationFieldRepository implements ApplicationFieldRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  add(applicationId: string, answers: readonly ApplicationAnswer[]): ApplicationAnswer[] {
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        return answers.map((input) => {
          const a = ApplicationAnswer.parse(input);
          tx.insert(applicationFields)
            .values({
              id: a.field.id,
              applicationId,
              fieldKey: a.field.normalizedQuestion,
              label: a.field.label,
              normalizedQuestion: a.field.normalizedQuestion,
              type: a.field.type,
              required: a.field.required,
              options: a.field.options,
              snapshotGeneration: 0,
              category: a.field.category,
              origin: a.field.origin,
              createdAt: now,
            })
            .run();
          this.writeAnswer(tx, a);
          return a;
        });
      },
      { behavior: "immediate" },
    );
  }

  list(applicationId: string): ApplicationAnswer[] {
    const rows = this.db
      .select({ f: applicationFields, a: applicationAnswers })
      .from(applicationFields)
      .innerJoin(applicationAnswers, eq(applicationAnswers.fieldId, applicationFields.id))
      .where(eq(applicationFields.applicationId, applicationId))
      .orderBy(asc(applicationFields.createdAt), asc(applicationFields.id))
      .all();
    return rows.map(({ f, a }) =>
      ApplicationAnswer.parse({
        field: {
          id: f.id,
          label: f.label,
          normalizedQuestion: f.normalizedQuestion,
          type: f.type,
          required: f.required,
          options: f.options,
          category: f.category,
          origin: f.origin,
        },
        proposedValue:
          a.proposedValueEnc === null
            ? null
            : this.open(a.proposedValueEnc, `application_answers.proposed:${f.id}`),
        provenance: a.provenance,
        confidence: a.confidence,
        sensitivity: a.sensitivity,
        decision: a.decision,
        reviewerChanges: a.reviewerChanges,
        finalValue:
          a.finalValueEnc === null
            ? null
            : this.open(a.finalValueEnc, `application_answers.final:${f.id}`),
        finalValueSetBy: a.finalValueSetBy,
        notes: a.notes,
      }),
    );
  }

  saveAnswer(applicationId: string, input: ApplicationAnswer): ApplicationAnswer {
    const a = ApplicationAnswer.parse(input);
    const field = this.db
      .select()
      .from(applicationFields)
      .where(
        and(
          eq(applicationFields.id, a.field.id),
          eq(applicationFields.applicationId, applicationId),
        ),
      )
      .get();
    if (!field) throw new NotFoundError("Question not found.");
    this.db.transaction(
      (tx) => {
        tx.delete(applicationAnswers).where(eq(applicationAnswers.fieldId, a.field.id)).run();
        this.writeAnswer(tx, a);
      },
      { behavior: "immediate" },
    );
    return a;
  }

  remove(applicationId: string, fieldId: string): void {
    this.db.transaction(
      (tx) => {
        const field = tx
          .select()
          .from(applicationFields)
          .where(
            and(
              eq(applicationFields.id, fieldId),
              eq(applicationFields.applicationId, applicationId),
            ),
          )
          .get();
        if (!field) throw new NotFoundError("Question not found.");
        tx.delete(applicationAnswers).where(eq(applicationAnswers.fieldId, fieldId)).run();
        tx.delete(applicationFields).where(eq(applicationFields.id, fieldId)).run();
      },
      { behavior: "immediate" },
    );
  }

  private writeAnswer(ex: Executor, a: ApplicationAnswer): void {
    ex.insert(applicationAnswers)
      .values({
        id: uuidv7(),
        fieldId: a.field.id,
        proposedValueEnc:
          a.proposedValue === null
            ? null
            : this.seal(a.proposedValue, `application_answers.proposed:${a.field.id}`),
        finalValueEnc:
          a.finalValue === null
            ? null
            : this.seal(a.finalValue, `application_answers.final:${a.field.id}`),
        finalValueSetBy: a.finalValueSetBy,
        provenance: a.provenance,
        confidence: a.confidence,
        sensitivity: a.sensitivity,
        decision: a.decision,
        reviewerChanges: a.reviewerChanges,
        notes: a.notes,
        updatedAt: this.now(),
      })
      .run();
  }

  private seal(v: string, aad: string): string {
    if (!this.cipher)
      throw new PolicyError("Application answers require an encryption key (DATA_ENCRYPTION_KEY).");
    return this.cipher.encrypt(v, aad);
  }

  private open(v: string, aad: string): string {
    if (!this.cipher)
      throw new PolicyError("Reading application answers requires the encryption key.");
    return this.cipher.decrypt(v, aad);
  }
}
