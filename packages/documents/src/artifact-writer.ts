import type { ArtifactRepository, ArtifactWriter } from "@career-agent/domain";
import type { FileArtifactStore } from "./artifact-store.js";

/** Writes bytes to the content-addressed store and records them in the artifacts table (idempotent by hash). */
export function createArtifactWriter(
  files: FileArtifactStore,
  repo: Pick<ArtifactRepository, "put">,
): ArtifactWriter {
  return {
    write(data, extension, kind, mediaType) {
      const stored = files.put(data, extension);
      const rec = repo.put({
        sha256: stored.sha256,
        mediaType,
        byteSize: data.length,
        kind,
        storagePath: stored.storagePath,
      });
      return { id: rec.id, sha256: rec.sha256 };
    },
  };
}
