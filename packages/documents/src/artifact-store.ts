import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ValidationError } from "@career-agent/domain";
import { artifactStorageName, resolveInside, sha256Hex } from "@career-agent/security";

/**
 * Immutable, content-addressed file storage under ARTIFACT_DIR. Files are written owner-only and atomically
 * (temp file + rename); writing the same content twice is a no-op.
 */
export class FileArtifactStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  put(data: Buffer, extension: string): { sha256: string; storagePath: string } {
    const sha256 = sha256Hex(data);
    const storagePath = artifactStorageName(sha256, extension);
    const target = resolveInside(this.root, storagePath);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
      renameSync(tmp, target);
    }
    return { sha256, storagePath };
  }

  /** Reads an artifact and verifies its hash, so tampered files are never used. */
  read(storagePath: string, expectedSha256: string): Buffer {
    const data = readFileSync(resolveInside(this.root, storagePath));
    if (sha256Hex(data) !== expectedSha256)
      throw new ValidationError("Artifact content does not match its hash.");
    return data;
  }
}
