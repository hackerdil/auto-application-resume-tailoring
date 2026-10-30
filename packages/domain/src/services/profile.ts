import type {
  AuditRepository,
  ProfileRepository,
  SavedAnswerRepository,
  UnitOfWork,
} from "../repositories.js";
import type { CandidateProfile, ProfileDraftInput, SavedAnswer } from "../schemas/profile.js";
import type { Sensitivity } from "../schemas/common.js";

export interface ProfileServiceDeps {
  uow: UnitOfWork;
  profiles: ProfileRepository;
  savedAnswers: SavedAnswerRepository;
  audit: AuditRepository;
}

const event = (traceId: string, type: string, metadata: Record<string, unknown>) => ({
  traceId,
  runId: null,
  taskId: null,
  applicationId: null,
  jobId: null,
  actor: "user" as const,
  type,
  prevState: null,
  newState: null,
  approvalId: null,
  artifactHashes: [],
  provider: null,
  model: null,
  durationMs: null,
  metadata,
});

/** Normalizes a question so saved answers match regardless of case, punctuation, or spacing. */
export function normalizeQuestion(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class ProfileService {
  constructor(private readonly d: ProfileServiceDeps) {}

  get(userId: string): CandidateProfile | null {
    return this.d.profiles.get(userId);
  }

  save(userId: string, draft: ProfileDraftInput, traceId: string): CandidateProfile {
    return this.d.uow.transaction(() => {
      const p = this.d.profiles.save(userId, draft);
      this.d.audit.append(event(traceId, "profile.saved", { version: p.version }));
      return p;
    });
  }

  /** Explicit owner answers only; replaces any active answer for the same question. */
  saveAnswer(
    userId: string,
    input: { question: string; value: string; sensitivity: Sensitivity },
    traceId: string,
  ): SavedAnswer {
    const normalizedQuestion = normalizeQuestion(input.question);
    return this.d.uow.transaction(() => {
      const prev = this.d.savedAnswers.findActive(userId, normalizedQuestion);
      if (prev) this.d.savedAnswers.revoke(prev.id);
      const saved = this.d.savedAnswers.save({
        userId,
        normalizedQuestion,
        value: input.value,
        sensitivity: input.sensitivity,
      });
      this.d.audit.append(
        event(traceId, "saved_answer.saved", {
          savedAnswerId: saved.id,
          sensitivity: saved.sensitivity,
          replaced: prev?.id ?? null,
        }),
      );
      return saved;
    });
  }

  revokeAnswer(userId: string, id: string, traceId: string): void {
    this.d.uow.transaction(() => {
      this.d.savedAnswers.revoke(id);
      this.d.audit.append(event(traceId, "saved_answer.revoked", { savedAnswerId: id, userId }));
    });
  }
}
