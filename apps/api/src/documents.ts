import type { DocumentPorts } from "@career-agent/domain";
import {
  extractCandidates,
  FileArtifactStore,
  parseResume,
  type ExtractOptions,
} from "@career-agent/documents";

/** Wires the documents package into the domain's DocumentPorts. */
export function documentPorts(
  artifactDir: string,
  extraction: Omit<ExtractOptions, "traceId" | "artifactId"> = {},
): DocumentPorts {
  const files = new FileArtifactStore(artifactDir);
  return {
    parse: (buf) => parseResume(buf),
    store: (buf, ext) => files.put(buf, ext),
    extract: async (text, ctx) => {
      const r = await extractCandidates(text, {
        ...extraction,
        traceId: ctx.traceId,
        artifactId: ctx.artifactId,
      });
      return {
        ...r,
        candidates: r.candidates.map(
          ({ category, claim, evidenceText, sourceLocation, extractor, sensitive }) => ({
            category,
            claim,
            evidenceText,
            sourceLocation,
            extractor,
            sensitive,
          }),
        ),
      };
    },
  };
}
