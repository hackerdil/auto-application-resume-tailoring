import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "@career-agent/db";
import {
  DISCOVER_SOURCE_TASK,
  DiscoveryService,
  MatchingService,
  ValidationError,
} from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import { FieldCipher } from "@career-agent/security";
import { createDiscoveryPorts, createSourceHttp, OriginScheduler } from "@career-agent/sources";
import { createFixtureHttp, type FixtureRoute } from "@career-agent/testkit";
import { Worker } from "./worker.js";

const LEVER = "https://api.lever.co/v0/postings/globexexample?mode=json";
const GH_LIST = "https://boards-api.greenhouse.io/v1/boards/acmefictional/jobs?content=true";
const GH_BOARD = "https://boards-api.greenhouse.io/v1/boards/acmefictional";
const ASHBY =
  "https://api.ashbyhq.com/posting-api/job-board/initech-example?includeCompensation=true";

function setup(
  routes: Record<string, FixtureRoute | FixtureRoute[]>,
  now = new Date("2026-10-29T12:00:00Z"),
) {
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k", { k: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const fx = createFixtureHttp(routes);
  const discovery = new DiscoveryService({
    jobs: store.jobs,
    sources: store.jobSources,
    fetches: store.jobFetches,
    profiles: store.profiles,
    audit: store.audit,
    // The real retrying client around fixture responses, with pacing waits disabled.
    ports: createDiscoveryPorts({
      http: createSourceHttp({
        get: fx.http,
        scheduler: new OriginScheduler(
          0,
          () => 0,
          () => Promise.resolve(),
        ),
        baseDelayMs: 0,
      }),
      now: () => now,
    }),
    freshnessDays: 30,
    now: () => now,
  });
  const matching = new MatchingService({
    jobs: store.jobs,
    facts: store.facts,
    profiles: store.profiles,
    savedAnswers: store.savedAnswers,
    matches: store.matches,
    requirements: store.jobRequirements,
    providerRuns: store.providerRuns,
    audit: store.audit,
    strongThreshold: 70,
  });
  const worker = new Worker({
    store,
    discovery,
    matching,
    maxJobsScoredPerRun: 50,
    ownerId,
    workerId: "w1",
    logger: createLogger({ level: "silent" }),
  });
  return { store, ownerId, discovery, worker, fx };
}

describe("discovery", () => {
  it("ingests a source, applies hard filters, and records the fetch", async () => {
    const { store, ownerId, discovery } = setup({ [LEVER]: { file: "ats/lever-postings.json" } });
    store.profiles.save(ownerId, {
      fullName: { value: "Alex Example" },
      preferences: { workModes: ["remote"] },
    });
    const src = discovery.addSource(
      { type: "lever", identifier: "GlobexExample", displayName: "Globex Example Inc" },
      "t",
    );
    const s = await discovery.runSource(src.id, ownerId, "t");
    expect(s).toMatchObject({ outcome: "ok", listed: 1, created: 1, filtered: 1, skipped: 1 });
    const job = store.jobs.list({ limit: 10, offset: 0 }).items[0];
    expect(job).toMatchObject({ company: "Globex Example Inc", status: "FILTERED" });
    // The fixture posting is hybrid (not in preferences) and 37 days old (freshness limit 30).
    expect(job?.filterReasons.map((r) => r.split(":")[0])).toEqual(["stale", "work_mode"]);
    expect(store.jobFetches.latestForSource(src.id)).toMatchObject({
      outcome: "ok",
      itemCount: 1,
      skippedCount: 1,
      newCount: 1,
    });
  });

  it("dedupes on re-run, keeps status, and marks postings that disappeared", async () => {
    const { store, ownerId, discovery } = setup({
      [GH_LIST]: [{ file: "ats/greenhouse-jobs.json" }, { body: '{"jobs":[]}' }],
      [GH_BOARD]: { file: "ats/greenhouse-board.json" },
    });
    const src = discovery.addSource({ type: "greenhouse", identifier: "acmefictional" }, "t");
    expect((await discovery.runSource(src.id, ownerId, "t")).created).toBe(2);
    const second = await discovery.runSource(src.id, ownerId, "t");
    expect(second).toMatchObject({ created: 0, removed: 2 });
    const jobs = store.jobs.list({ limit: 10, offset: 0 });
    expect(jobs.total).toBe(2);
    expect(jobs.items.every((j) => j.removedFromSourceAt !== null)).toBe(true);
    expect(
      store.jobs.list({ search: "junior", limit: 10, offset: 0 }).items.map((j) => j.title),
    ).toEqual(["Junior Data Analyst"]);
  });

  it("uses conditional requests: 304 changes nothing", async () => {
    const { ownerId, discovery, store } = setup({
      [GH_LIST]: [
        { file: "ats/greenhouse-jobs.json", headers: { etag: '"v1"' } },
        { status: 304, headers: { etag: '"v1"' } },
      ],
      [GH_BOARD]: { file: "ats/greenhouse-board.json" },
    });
    const src = discovery.addSource({ type: "greenhouse", identifier: "acmefictional" }, "t");
    await discovery.runSource(src.id, ownerId, "t");
    expect((await discovery.runSource(src.id, ownerId, "t")).outcome).toBe("not_modified");
    expect(
      store.jobs.list({ limit: 10, offset: 0 }).items.every((j) => j.removedFromSourceAt === null),
    ).toBe(true);
  });

  it("isolates source failures and classifies them", async () => {
    const { ownerId, discovery, store } = setup({ [ASHBY]: { status: 503 } });
    const bad = discovery.addSource({ type: "ashby", identifier: "initech-example" }, "t");
    const missing = discovery.addSource({ type: "lever", identifier: "nobody-here" }, "t");
    const r1 = await discovery.runSource(bad.id, ownerId, "t");
    const r2 = await discovery.runSource(missing.id, ownerId, "t");
    expect(r1).toMatchObject({
      outcome: "error",
      error: { errorClass: "source_unavailable", retryable: true },
    });
    expect(r2).toMatchObject({
      outcome: "error",
      error: { errorClass: "source_not_found", retryable: false },
    });
    expect(store.jobFetches.latestForSource(bad.id)?.errorMessage).toMatch(/HTTP 503/);
  });

  it("flags cross-source duplicates by content", async () => {
    const LEVER_EU = "https://api.eu.lever.co/v0/postings/globexexample?mode=json";
    const { ownerId, discovery, store } = setup({
      [LEVER]: { file: "ats/lever-postings.json" },
      [LEVER_EU]: { file: "ats/lever-postings.json" },
    });
    const a = discovery.addSource({ type: "lever", identifier: "globexexample" }, "t");
    const b = discovery.addSource({ type: "lever", identifier: "eu/globexexample" }, "t");
    await discovery.runSource(a.id, ownerId, "t");
    await discovery.runSource(b.id, ownerId, "t");
    const all = store.jobs.list({ limit: 10, offset: 0 }).items;
    expect(all).toHaveLength(2);
    const eu = all.find((j) => j.id.startsWith("lever:eu/"));
    expect(
      eu?.filterReasons.some((r) =>
        r.startsWith("duplicate: same posting as lever:globexexample/"),
      ),
    ).toBe(true);
  });

  it("rejects unsupported or disabled source types and bad identifiers", () => {
    const { discovery } = setup({});
    expect(() => discovery.addSource({ type: "workable", identifier: "x" }, "t")).toThrow(
      /Workable is disabled/,
    );
    expect(() => discovery.addSource({ type: "generic", identifier: "x" }, "t")).toThrow(
      ValidationError,
    );
    expect(() => discovery.addSource({ type: "lever", identifier: "../../etc" }, "t")).toThrow(
      ValidationError,
    );
    discovery.addSource({ type: "lever", identifier: "globexexample" }, "t");
    expect(() => discovery.addSource({ type: "lever", identifier: "GLOBEXEXAMPLE" }, "t")).toThrow(
      /already configured/,
    );
  });

  it("only allows owner decisions through the state machine", async () => {
    const { ownerId, discovery } = setup({ [LEVER]: { file: "ats/lever-postings.json" } });
    const src = discovery.addSource({ type: "lever", identifier: "globexexample" }, "t");
    await discovery.runSource(src.id, ownerId, "t");
    const id = "lever:globexexample/0b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
    expect(() => discovery.setStatus(id, "SHORTLISTED", "t")).toThrow(/not allowed/); // must be scored first (Phase 4)
    expect(() => discovery.setStatus(id, "SCORED", "t")).toThrow(
      /only shortlist, skip, or archive/,
    );
  });
});

describe("worker", () => {
  it("runs queued discovery tasks and retries transient failures", async () => {
    const { store, discovery, worker } = setup({
      [ASHBY]: [
        { status: 503 },
        { status: 503 },
        { status: 503 },
        { file: "ats/ashby-board.json" },
      ],
    });
    const src = discovery.addSource({ type: "ashby", identifier: "initech-example" }, "t");
    const task = store.tasks.enqueue(
      DISCOVER_SOURCE_TASK,
      { sourceId: src.id, traceId: "t" },
      `discover:${src.id}:1`,
    );
    expect(await worker.tick()).toBe(true);
    // The HTTP client retried internally twice; the task itself is now queued for a later retry with backoff.
    expect(store.tasks.get(task.id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(store.tasks.hasActive(`discover:${src.id}:`)).toBe(true);
    expect(await worker.tick()).toBe(false); // backoff not elapsed
  });

  it("fails unknown task kinds without retry", async () => {
    const { store, worker } = setup({});
    const t = store.tasks.enqueue("mystery", {}, "m1");
    await worker.tick();
    expect(store.tasks.get(t.id)?.status).toBe("failed");
  });
});
