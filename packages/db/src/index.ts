import type { FieldCipher } from "@career-agent/security";
import { openDatabase, runMigrations, type OpenedDatabase } from "./database.js";
import { SqliteApplicationRepository } from "./repositories/applications.js";
import { SqliteArtifactRepository } from "./repositories/artifacts.js";
import {
  SqliteCandidateRepository,
  SqliteDocumentTextRepository,
} from "./repositories/candidates.js";
import { SqliteIdempotencyRepository } from "./repositories/idempotency.js";
import { SqliteProfileRepository } from "./repositories/profiles.js";
import { SqliteAuditRepository } from "./repositories/audit.js";
import { SqliteFactRepository } from "./repositories/facts.js";
import { SqliteJobFetchRepository, SqliteJobSourceRepository } from "./repositories/job-sources.js";
import { SqliteJobRepository } from "./repositories/jobs.js";
import { SqliteApplicationFieldRepository } from "./repositories/application-fields.js";
import { SqliteBrowserSessionRepository } from "./repositories/browser-sessions.js";
import {
  SqliteApprovalRepository,
  SqliteSubmissionAttemptRepository,
} from "./repositories/approvals.js";
import { SqliteCoverLetterRepository } from "./repositories/cover-letters.js";
import { SqliteResumeVersionRepository } from "./repositories/resumes.js";
import {
  SqliteJobRequirementRepository,
  SqliteMatchRepository,
  SqliteProviderRunRepository,
} from "./repositories/matches.js";
import { SqliteSavedAnswerRepository } from "./repositories/saved-answers.js";
import { SqliteTaskRepository } from "./repositories/tasks.js";
import { SqliteUserRepository } from "./repositories/users.js";
import { systemClock, type Clock } from "./time.js";

export {
  openDatabase,
  runMigrations,
  MIGRATIONS_FOLDER,
  type Db,
  type OpenedDatabase,
} from "./database.js";
export type { Clock } from "./time.js";

export interface StoreOptions {
  /** File path or ":memory:". */
  file: string;
  /** Required for sensitive columns; without it, writes of sensitive data fail closed. */
  cipher: FieldCipher | null;
  now?: Clock;
  migrate?: boolean;
}

/** Opens (and by default migrates) the database and wires every repository. */
export function createStore(opts: StoreOptions) {
  const opened: OpenedDatabase = openDatabase(opts.file);
  if (opts.migrate !== false) runMigrations(opened.db);
  const now = opts.now ?? systemClock;
  const { db } = opened;
  return {
    ...opened,
    /** Unit of work: repository calls inside `fn` commit or roll back together (nested transactions become savepoints). */
    transaction: <T>(fn: () => T): T => opened.sqlite.transaction(fn).immediate(),
    users: new SqliteUserRepository(db, now),
    audit: new SqliteAuditRepository(db, now),
    facts: new SqliteFactRepository(db, opts.cipher, now),
    savedAnswers: new SqliteSavedAnswerRepository(db, opts.cipher, now),
    jobs: new SqliteJobRepository(db, now),
    jobSources: new SqliteJobSourceRepository(db, now),
    jobFetches: new SqliteJobFetchRepository(db),
    matches: new SqliteMatchRepository(db),
    jobRequirements: new SqliteJobRequirementRepository(db),
    providerRuns: new SqliteProviderRunRepository(db, now),
    resumes: new SqliteResumeVersionRepository(db, now),
    applicationFields: new SqliteApplicationFieldRepository(db, opts.cipher, now),
    coverLetters: new SqliteCoverLetterRepository(db, now),
    artifacts: new SqliteArtifactRepository(db, now),
    applications: new SqliteApplicationRepository(db, now),
    browserSessions: new SqliteBrowserSessionRepository(db, now),
    approvals: new SqliteApprovalRepository(db, now),
    submissionAttempts: new SqliteSubmissionAttemptRepository(db, now),
    tasks: new SqliteTaskRepository(db, now),
    profiles: new SqliteProfileRepository(db, opts.cipher, now),
    candidates: new SqliteCandidateRepository(db, opts.cipher, now),
    documentTexts: new SqliteDocumentTextRepository(db, opts.cipher, now),
    idempotency: new SqliteIdempotencyRepository(db, opts.cipher, now),
  };
}

export type Store = ReturnType<typeof createStore>;
export {
  exportAllData,
  deleteLocalData,
  assertSafeDeletionTarget,
  type DeletionTargets,
} from "./local-data.js";
export { bootstrap, type Bootstrapped } from "./bootstrap.js";
