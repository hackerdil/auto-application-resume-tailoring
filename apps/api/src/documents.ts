import type { AIProvider } from "@career-agent/ai";
import type { DocumentPorts, RunLimits } from "@career-agent/domain";
import {
  extractCandidates,
  FileArtifactStore,
  parseResume,
  type ExtractOptions,
} from "@career-agent/documents";

/** Wires the documents package into the domain's DocumentPorts. */
/** One extraction call per upload: bounded time, input, and cost. */
export const EXTRACTION_LIMITS: RunLimits = {
  deadlineMs: 120_000,
  maxModelTurns: 2,
  maxToolCalls: 0,
  maxBrowserSteps: 0,
  maxRetries: 1,
  maxInputChars: 60_000,
  maxOutputTokens: 8_000,
  maxCostUsd: 0.5,
};

export function documentPorts(
  artifactDir: string,
  provider: AIProvider | null = null,
): DocumentPorts {
  const extraction: Omit<ExtractOptions, "traceId" | "artifactId" | "signal"> = provider
    ? { provider, limits: EXTRACTION_LIMITS }
    : {};
  const files = new FileArtifactStore(artifactDir);
  return {
    parse: (buf) => parseResume(buf),
    store: (buf, ext) => files.put(buf, ext),
    extract: async (text, ctx) => {
      const r = await extractCandidates(text, {
        ...extraction,
        signal: AbortSignal.timeout(EXTRACTION_LIMITS.deadlineMs),
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
