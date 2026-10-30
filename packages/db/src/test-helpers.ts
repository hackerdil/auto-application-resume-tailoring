// Test-only helpers for the db package. Fixtures are fictional (see scripts/scan-fixtures.mjs).
import { randomBytes } from "node:crypto";
import { canonicalJobId, type Job, type NewVerifiedFact } from "@career-agent/domain";
import { FieldCipher, sha256Hex } from "@career-agent/security";
import { createStore } from "./index.js";

export function testCipher(): FieldCipher {
  return new FieldCipher("test", { test: randomBytes(32) });
}

export function testStore(opts: { cipher?: FieldCipher | null; start?: number } = {}) {
  let t = opts.start ?? Date.UTC(2026, 9, 29, 12);
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const store = createStore({
    file: ":memory:",
    cipher: opts.cipher === undefined ? testCipher() : opts.cipher,
    now: clock.now,
  });
  return { store, clock };
}

export function fixtureJob(over: Partial<Job> = {}): Job {
  const now = new Date(Date.UTC(2026, 9, 29)).toISOString();
  const description = over.descriptionText ?? "Build reliable TypeScript services.";
  return {
    id: canonicalJobId("greenhouse", "1001"),
    source: "greenhouse",
    externalId: "1001",
    sourceUrl: "https://boards.greenhouse.io/acme-fictional/jobs/1001",
    applyUrl: "https://boards.greenhouse.io/acme-fictional/jobs/1001#app",
    company: "Acme Fictional Ltd",
    title: "Software Engineer",
    team: null,
    locations: ["Remote"],
    workMode: "remote",
    employmentType: "full_time",
    seniority: "mid",
    descriptionText: description,
    descriptionHtmlSanitized: null,
    requiredQualifications: ["TypeScript"],
    preferredQualifications: [],
    compensation: null,
    sponsorship: { value: "unknown", confidence: 0, evidence: null },
    postedAt: null,
    updatedAt: null,
    firstSeenAt: now,
    lastSeenAt: now,
    sourceHash: sha256Hex("raw:" + description),
    contentHash: sha256Hex(description),
    status: "DISCOVERED",
    filterReasons: [],
    removedFromSourceAt: null,
    ...over,
  };
}

export function fixtureFact(over: Partial<NewVerifiedFact> = {}): NewVerifiedFact {
  return {
    category: "skill",
    claim: "Wrote production TypeScript services",
    source: "user-confirmed",
    verifiedAt: new Date(Date.UTC(2026, 9, 29)).toISOString(),
    allowedTransformations: ["select", "rephrase"],
    sensitive: false,
    ...over,
  };
}
