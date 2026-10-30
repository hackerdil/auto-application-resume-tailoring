import { eq } from "drizzle-orm";
import {
  uuidv7,
  ValidationError,
  type ArtifactRecord,
  type ArtifactRepository,
} from "@career-agent/domain";
import type { Db } from "../database.js";
import { artifacts } from "../schema.js";
import { toIso, type Clock } from "../time.js";

export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  put(record: Omit<ArtifactRecord, "id" | "createdAt">): ArtifactRecord {
    if (!/^[0-9a-f]{64}$/.test(record.sha256))
      throw new ValidationError("Artifact sha256 must be lowercase hex.");
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(artifacts)
          .where(eq(artifacts.sha256, record.sha256))
          .get();
        if (existing) return { ...existing, createdAt: toIso(existing.createdAt) };
        const row = { ...record, id: uuidv7(), createdAt: this.now() };
        tx.insert(artifacts).values(row).run();
        return { ...row, createdAt: toIso(row.createdAt) };
      },
      { behavior: "immediate" },
    );
  }

  getBySha256(sha256: string): ArtifactRecord | null {
    const row = this.db.select().from(artifacts).where(eq(artifacts.sha256, sha256)).get();
    return row ? { ...row, createdAt: toIso(row.createdAt) } : null;
  }

  get(id: string): ArtifactRecord | null {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? { ...row, createdAt: toIso(row.createdAt) } : null;
  }
}
