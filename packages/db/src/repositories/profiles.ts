import { desc, eq } from "drizzle-orm";
import {
  CandidateProfile,
  PolicyError,
  ProfileDraft,
  uuidv7,
  type ProfileDraftInput,
  type ProfileRepository,
} from "@career-agent/domain";
import type { FieldCipher } from "@career-agent/security";
import type { Db } from "../database.js";
import { candidateProfiles, profileVersions } from "../schema.js";
import { toIso, type Clock } from "../time.js";

/** Profiles are stored as encrypted JSON; each save appends an immutable version (ADR-005, ADR-018). */
export class SqliteProfileRepository implements ProfileRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher | null,
    private readonly now: Clock,
  ) {}

  get(userId: string): CandidateProfile | null {
    const row = this.db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.userId, userId))
      .get();
    if (!row) return null;
    return CandidateProfile.parse(
      JSON.parse(this.requireCipher().decrypt(row.dataEnc, `candidate_profiles.data:${row.id}`)),
    );
  }

  save(userId: string, input: ProfileDraftInput): CandidateProfile {
    const draft = ProfileDraft.parse(input);
    const cipher = this.requireCipher();
    return this.db.transaction(
      (tx) => {
        const now = this.now();
        const existing = tx
          .select()
          .from(candidateProfiles)
          .where(eq(candidateProfiles.userId, userId))
          .get();
        const id = existing?.id ?? uuidv7();
        const version = (existing?.currentVersion ?? 0) + 1;
        const createdAt = existing?.createdAt ?? now;
        const profile = CandidateProfile.parse({
          ...draft,
          id,
          userId,
          version,
          createdAt: toIso(createdAt),
          updatedAt: toIso(now),
        });
        const json = JSON.stringify(profile);
        const dataEnc = cipher.encrypt(json, `candidate_profiles.data:${id}`);
        if (existing) {
          tx.update(candidateProfiles)
            .set({ currentVersion: version, dataEnc, updatedAt: now })
            .where(eq(candidateProfiles.id, id))
            .run();
        } else {
          tx.insert(candidateProfiles)
            .values({ id, userId, currentVersion: version, dataEnc, createdAt, updatedAt: now })
            .run();
        }
        const versionId = uuidv7();
        tx.insert(profileVersions)
          .values({
            id: versionId,
            profileId: id,
            version,
            dataEnc: cipher.encrypt(json, `profile_versions.data:${versionId}`),
            createdAt: now,
          })
          .run();
        return profile;
      },
      { behavior: "immediate" },
    );
  }

  listVersions(userId: string): { version: number; createdAt: string }[] {
    const profile = this.db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.userId, userId))
      .get();
    if (!profile) return [];
    return this.db
      .select({ version: profileVersions.version, createdAt: profileVersions.createdAt })
      .from(profileVersions)
      .where(eq(profileVersions.profileId, profile.id))
      .orderBy(desc(profileVersions.version))
      .all()
      .map((r) => ({ version: r.version, createdAt: toIso(r.createdAt) }));
  }

  private requireCipher(): FieldCipher {
    if (!this.cipher)
      throw new PolicyError("The profile requires an encryption key (DATA_ENCRYPTION_KEY).");
    return this.cipher;
  }
}
