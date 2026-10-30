import { and, eq } from "drizzle-orm";
import {
  ConflictError,
  PolicyError,
  type IdempotencyRepository,
  type StoredResponse,
} from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { idempotencyKeys } from "../schema.js";
import type { Clock } from "../time.js";

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  lookup(key: string, scope: string, requestHash: string): StoredResponse | null {
    const row = this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope)))
      .get();
    if (!row) return null;
    if (row.requestHash !== requestHash)
      throw new ConflictError("This Idempotency-Key was already used for a different request.");
    const body: unknown = JSON.parse(
      this.requireCipher().decrypt(row.responseEnc, `idempotency_keys.response:${scope}:${key}`),
    );
    return { statusCode: row.statusCode, body };
  }

  save(key: string, scope: string, requestHash: string, response: StoredResponse): void {
    const responseEnc = this.requireCipher().encrypt(
      JSON.stringify(response.body ?? null),
      `idempotency_keys.response:${scope}:${key}`,
    );
    this.db
      .insert(idempotencyKeys)
      .values({
        key,
        scope,
        requestHash,
        statusCode: response.statusCode,
        responseEnc,
        createdAt: this.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  private requireCipher(): FieldCipher {
    if (!this.cipher) throw new PolicyError("Idempotency records require an encryption key.");
    return this.cipher;
  }
}
