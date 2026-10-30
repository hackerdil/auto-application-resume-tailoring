import { ConflictError } from "@career-agent/domain";

/** Maps SQLite constraint violations to domain errors without leaking SQL or paths. */
export function mapConstraintError(err: unknown, message: string): never {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code.startsWith("SQLITE_CONSTRAINT")) throw new ConflictError(message, { cause: err });
  throw err;
}
