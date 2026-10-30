import type { JobSourceType } from "@career-agent/domain";
import { ashbyAdapter } from "./adapters/ashby.js";
import { greenhouseAdapter } from "./adapters/greenhouse.js";
import { leverAdapter } from "./adapters/lever.js";
import type { JobSourceAdapter } from "./adapters/types.js";

/** Approved discovery sources. Workable is deliberately absent until its terms are reviewed (ADR-022). */
export const ADAPTERS = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
} as const satisfies Partial<Record<JobSourceType, JobSourceAdapter>>;

export type DiscoverySourceType = keyof typeof ADAPTERS;

export function adapterFor(type: string): JobSourceAdapter | null {
  return type in ADAPTERS ? ADAPTERS[type as DiscoverySourceType] : null;
}
