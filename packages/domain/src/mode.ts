import { PolicyError } from "./errors.js";
import type { OperatingMode } from "./schemas/run.js";

export type Capability =
  | "discover"
  | "score"
  | "tailor"
  | "draft"
  | "open_browser"
  | "authenticate"
  | "prefill"
  | "issue_approval"
  | "submit"
  | "external_write";

const CAPABILITIES: Readonly<Record<OperatingMode, ReadonlySet<Capability>>> = {
  "research-only": new Set(["discover", "score"]),
  prepare: new Set([
    "discover",
    "score",
    "tailor",
    "draft",
    "open_browser",
    "authenticate",
    "prefill",
  ]),
  "review-each": new Set([
    "discover",
    "score",
    "tailor",
    "draft",
    "open_browser",
    "authenticate",
    "prefill",
    "issue_approval",
    "submit",
    "external_write",
  ]),
  // Fixtures only: may exercise tailoring/drafting/prefill against local fixture pages, never authenticate or write externally.
  "dry-run": new Set(["discover", "score", "tailor", "draft", "open_browser", "prefill"]),
};

export const DEFAULT_MODE: OperatingMode = "review-each";

export function modeAllows(mode: OperatingMode, capability: Capability): boolean {
  return CAPABILITIES[mode].has(capability);
}

export function assertModeAllows(mode: OperatingMode, capability: Capability): void {
  if (!modeAllows(mode, capability)) {
    throw new PolicyError(`Operating mode "${mode}" does not allow "${capability}".`);
  }
}
