import { uuidv7, type UserRepository } from "@career-agent/domain";
import type { Db } from "../database.js";
import { users } from "../schema.js";
import type { Clock } from "../time.js";

export class SqliteUserRepository implements UserRepository {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  ensureOwner(displayName: string): { id: string; displayName: string } {
    return this.db.transaction(
      (tx) => {
        const existing = tx.select().from(users).get();
        if (existing) return { id: existing.id, displayName: existing.displayName };
        const id = uuidv7();
        tx.insert(users).values({ id, displayName, createdAt: this.now() }).run();
        return { id, displayName };
      },
      { behavior: "immediate" },
    );
  }
}
