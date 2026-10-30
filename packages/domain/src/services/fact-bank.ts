import { NotFoundError, ValidationError } from "../errors.js";
import type {
  ArtifactRepository,
  AuditRepository,
  CandidateRepository,
  DocumentTextRepository,
  FactRepository,
  NewAuditEvent,
  UnitOfWork,
} from "../repositories.js";
import type { FactCandidate, NewFactCandidate } from "../schemas/candidate.js";
import type {
  FactCategory,
  FactTransformation,
  NewVerifiedFact,
  VerifiedFact,
} from "../schemas/fact.js";

/** Ports implemented by @career-agent/documents (kept as functions so the domain stays I/O-free). */
export interface DocumentPorts {
  parse(buf: Buffer): Promise<{
    kind: "pdf" | "docx";
    mediaType: string;
    sha256: string;
    byteSize: number;
    pageCount: number | null;
    text: string;
    warnings: string[];
  }>;
  store(buf: Buffer, extension: string): { sha256: string; storagePath: string };
  extract(
    text: string,
    ctx: { artifactId: string; traceId: string },
  ): Promise<{
    candidates: NewFactCandidate[];
    rejected: number;
    modelUsed: boolean;
    warnings: string[];
  }>;
}

export interface FactBankDeps {
  uow: UnitOfWork;
  facts: FactRepository;
  candidates: CandidateRepository;
  documentTexts: DocumentTextRepository;
  artifacts: ArtifactRepository;
  audit: AuditRepository;
  documents: DocumentPorts;
  now?: () => Date;
}

export interface ImportResult {
  artifactId: string;
  sha256: string;
  kind: "pdf" | "docx";
  pageCount: number | null;
  candidates: FactCandidate[];
  rejectedSuggestions: number;
  modelUsed: boolean;
  warnings: string[];
  alreadyImported: boolean;
}

export interface FactEdits {
  claim?: string;
  category?: FactCategory;
  sensitive?: boolean;
  allowedTransformations?: FactTransformation[];
}

const DEFAULT_TRANSFORMATIONS: FactTransformation[] = [
  "select",
  "reorder",
  "shorten",
  "rephrase",
  "combine",
];

const audit = (
  traceId: string,
  type: string,
  metadata: Record<string, unknown> = {},
  artifactHashes: string[] = [],
): NewAuditEvent => ({
  traceId,
  runId: null,
  taskId: null,
  applicationId: null,
  jobId: null,
  actor: "user",
  type,
  prevState: null,
  newState: null,
  approvalId: null,
  artifactHashes,
  provider: null,
  model: null,
  durationMs: null,
  // Audit metadata never contains claim text or document content.
  metadata,
});

/**
 * The verified fact bank (spec §15 steps 1–4): import → suggested candidates → owner confirms, edits, or
 * rejects. Only owner-confirmed statements ever become VerifiedFacts.
 */
export class FactBankService {
  private readonly now: () => Date;

  constructor(private readonly d: FactBankDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async importResume(userId: string, buf: Buffer, traceId: string): Promise<ImportResult> {
    const parsed = await this.d.documents.parse(buf);
    const stored = this.d.documents.store(buf, parsed.kind);
    const artifact = this.d.artifacts.put({
      sha256: stored.sha256,
      mediaType: parsed.mediaType,
      byteSize: parsed.byteSize,
      kind: "resume_source",
      storagePath: stored.storagePath,
    });

    const existing = this.d.candidates.list(userId).filter((c) => c.artifactId === artifact.id);
    if (existing.length > 0) {
      return {
        artifactId: artifact.id,
        sha256: artifact.sha256,
        kind: parsed.kind,
        pageCount: parsed.pageCount,
        candidates: existing.filter((c) => c.status === "pending"),
        rejectedSuggestions: 0,
        modelUsed: false,
        warnings: ["This document was already imported; showing its remaining suggestions."],
        alreadyImported: true,
      };
    }

    this.d.documentTexts.put(artifact.id, parsed.text);
    const extraction = await this.d.documents.extract(parsed.text, {
      artifactId: artifact.id,
      traceId,
    });
    const candidates = this.d.uow.transaction(() => {
      const created = this.d.candidates.addMany(userId, artifact.id, extraction.candidates);
      this.d.audit.append(
        audit(
          traceId,
          "document.imported",
          {
            artifactId: artifact.id,
            kind: parsed.kind,
            pageCount: parsed.pageCount,
            candidates: created.length,
            rejectedSuggestions: extraction.rejected,
            modelUsed: extraction.modelUsed,
          },
          [artifact.sha256],
        ),
      );
      return created;
    });
    return {
      artifactId: artifact.id,
      sha256: artifact.sha256,
      kind: parsed.kind,
      pageCount: parsed.pageCount,
      candidates,
      rejectedSuggestions: extraction.rejected,
      modelUsed: extraction.modelUsed,
      warnings: [...parsed.warnings, ...extraction.warnings],
      alreadyImported: false,
    };
  }

  listCandidates(userId: string): FactCandidate[] {
    return this.d.candidates.list(userId, "pending");
  }

  listFacts(userId: string): VerifiedFact[] {
    return this.d.facts.listActive(userId);
  }

  /** Confirms a suggestion, optionally edited. An edited claim is recorded as user-confirmed, keeping the résumé evidence. */
  confirmCandidate(
    userId: string,
    candidateId: string,
    edits: FactEdits,
    traceId: string,
  ): VerifiedFact {
    const candidate = this.ownedCandidate(userId, candidateId);
    const claim = (edits.claim ?? candidate.claim).trim();
    if (!claim) throw new ValidationError("The fact cannot be empty.");
    const edited = claim !== candidate.claim;
    const fact: NewVerifiedFact = {
      category: edits.category ?? candidate.category,
      claim,
      source: edited ? "user-confirmed" : "resume",
      sourceArtifactId: candidate.artifactId,
      ...(candidate.sourceLocation ? { sourceLocation: candidate.sourceLocation } : {}),
      evidenceText: candidate.evidenceText,
      verifiedAt: this.now().toISOString(),
      allowedTransformations: edits.allowedTransformations ?? DEFAULT_TRANSFORMATIONS,
      sensitive: edits.sensitive ?? candidate.sensitive,
    };
    return this.d.uow.transaction(() => {
      const created = this.d.facts.add(userId, fact);
      this.d.candidates.decide(candidateId, { status: "confirmed", factId: created.id });
      this.d.audit.append(
        audit(traceId, "fact.confirmed", {
          factId: created.id,
          candidateId,
          category: created.category,
          edited,
          extractor: candidate.extractor,
        }),
      );
      return created;
    });
  }

  rejectCandidate(userId: string, candidateId: string, traceId: string): void {
    this.ownedCandidate(userId, candidateId);
    this.d.uow.transaction(() => {
      this.d.candidates.decide(candidateId, { status: "rejected" });
      this.d.audit.append(audit(traceId, "fact.candidate_rejected", { candidateId }));
    });
  }

  addFact(
    userId: string,
    input: Required<Pick<FactEdits, "claim" | "category">> & FactEdits,
    traceId: string,
  ): VerifiedFact {
    return this.d.uow.transaction(() => {
      const created = this.d.facts.add(userId, {
        category: input.category,
        claim: input.claim.trim(),
        source: "user-confirmed",
        verifiedAt: this.now().toISOString(),
        allowedTransformations: input.allowedTransformations ?? DEFAULT_TRANSFORMATIONS,
        sensitive: input.sensitive ?? false,
      });
      this.d.audit.append(
        audit(traceId, "fact.added", { factId: created.id, category: created.category }),
      );
      return created;
    });
  }

  /** Corrections never mutate the old fact: they append a replacement and mark the old one superseded. */
  correctFact(
    userId: string,
    factId: string,
    edits: FactEdits & { claim: string },
    traceId: string,
  ): VerifiedFact {
    const old = this.d.facts.get(factId);
    if (!old) throw new NotFoundError("Fact not found.");
    return this.d.uow.transaction(() => {
      const created = this.d.facts.supersede(userId, factId, {
        category: edits.category ?? old.category,
        claim: edits.claim.trim(),
        source: "user-confirmed",
        ...(old.sourceArtifactId ? { sourceArtifactId: old.sourceArtifactId } : {}),
        ...(old.sourceLocation ? { sourceLocation: old.sourceLocation } : {}),
        ...(old.evidenceText ? { evidenceText: old.evidenceText } : {}),
        verifiedAt: this.now().toISOString(),
        allowedTransformations: edits.allowedTransformations ?? old.allowedTransformations,
        sensitive: edits.sensitive ?? old.sensitive,
      });
      this.d.audit.append(
        audit(traceId, "fact.corrected", {
          factId: created.id,
          supersedes: factId,
          category: created.category,
        }),
      );
      return created;
    });
  }

  private ownedCandidate(userId: string, candidateId: string): FactCandidate {
    const c = this.d.candidates.get(candidateId);
    if (!c || c.userId !== userId) throw new NotFoundError("Suggestion not found.");
    return c;
  }
}
