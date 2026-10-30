import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@career-agent/config";
import { createStore } from "@career-agent/db";
import { DiscoveryService } from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import { FieldCipher } from "@career-agent/security";
import { createDiscoveryPorts, createSourceHttp, OriginScheduler } from "@career-agent/sources";
import { createFixtureHttp } from "@career-agent/testkit";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app.js";
import { documentPorts } from "./documents.js";

const API = "127.0.0.1:3001";
const LEVER = "https://api.lever.co/v0/postings/globexexample?mode=json";
const GH_ONE =
  "https://boards-api.greenhouse.io/v1/boards/acmefictional/jobs/4012001?pay_transparency=true";

async function setup() {
  const config = loadConfig({
    DATABASE_URL: ":memory:",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    JOB_FRESHNESS_DAYS: "60",
  });
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k1", { k1: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const fx = createFixtureHttp({
    [LEVER]: { file: "ats/lever-postings.json" },
    [GH_ONE]: { file: "ats/greenhouse-job-4012001.json" },
  });
  const ports = createDiscoveryPorts({
    http: createSourceHttp({
      get: fx.http,
      scheduler: new OriginScheduler(
        0,
        () => 0,
        () => Promise.resolve(),
      ),
    }),
    now: () => new Date("2026-10-29T12:00:00Z"),
  });
  const app = await buildApp({
    config,
    store,
    ownerId,
    ...(() => {
      const artifactDir = mkdtempSync(path.join(tmpdir(), "ca-jobs-"));
      return { documents: documentPorts(artifactDir), artifactDir };
    })(),
    discoveryPorts: ports,
    sessionSecret: randomBytes(32),
    logger: createLogger({ level: "silent" }),
  });
  const s = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: API } });
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const csrf = s.json<{ csrfToken: string }>().csrfToken;
  let n = 0;
  const call = (
    method: NonNullable<InjectOptions["method"]>,
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse> => {
    const opts: InjectOptions = {
      method,
      url,
      headers: {
        host: API,
        cookie,
        "x-csrf-token": csrf,
        origin: "http://127.0.0.1:3000",
        "idempotency-key": `jobs-test-${++n}`,
      },
    };
    if (body !== undefined) opts.payload = body as NonNullable<InjectOptions["payload"]>;
    return app.inject(opts);
  };
  // Stands in for the worker process: same store, same ports.
  const worker = new DiscoveryService({
    jobs: store.jobs,
    sources: store.jobSources,
    fetches: store.jobFetches,
    profiles: store.profiles,
    audit: store.audit,
    ports,
    freshnessDays: 60,
  });
  return { call, store, ownerId, worker, fx };
}

describe("job sources and discovery API", () => {
  it("adds sources, queues discovery once per source, and lists jobs", async () => {
    const { call, store, ownerId, worker } = await setup();
    const add = await call("POST", "/api/v1/job-sources", {
      type: "lever",
      identifier: "GlobexExample",
      displayName: "Globex Example Inc",
    });
    expect(add.statusCode).toBe(201);
    const source = add.json<{
      source: { id: string; identifier: string; allowedHosts: string[] };
    }>().source;
    expect(source).toMatchObject({
      identifier: "globexexample",
      allowedHosts: ["api.lever.co", "api.eu.lever.co"],
    });

    const q1 = await call("POST", "/api/v1/discovery", {});
    expect(q1.statusCode).toBe(202);
    expect(q1.json<{ queued: unknown[] }>().queued).toHaveLength(1);
    const q2 = await call("POST", "/api/v1/discovery", {});
    expect(q2.json<{ alreadyRunning: string[] }>().alreadyRunning).toEqual([source.id]);
    const listed = await call("GET", "/api/v1/job-sources");
    expect(listed.json<{ sources: { running: boolean }[] }>().sources[0]?.running).toBe(true);

    // Simulate the worker completing the task.
    const task = store.tasks.claim("w", 60_000);
    await worker.runSource(source.id, ownerId, "t");
    store.tasks.complete(task?.id ?? "", "w");

    const jobs = await call("GET", "/api/v1/jobs?status=ELIGIBLE,FILTERED&q=platform");
    const body = jobs.json<{ total: number; jobs: Record<string, unknown>[] }>();
    expect(body.total).toBe(1);
    expect(body.jobs[0]).toMatchObject({
      title: "Staff Platform Engineer",
      company: "Globex Example Inc",
      status: "ELIGIBLE",
    });
    expect(body.jobs[0]).not.toHaveProperty("descriptionText");

    const detail = await call(
      "GET",
      `/api/v1/jobs/detail?id=${encodeURIComponent(String(body.jobs[0]?.["id"]))}`,
    );
    expect(
      detail.json<{ job: { descriptionHtmlSanitized: string } }>().job.descriptionHtmlSanitized,
    ).toContain("Kubernetes");
    const tasks = await call("GET", "/api/v1/discovery/tasks");
    expect(tasks.json<{ tasks: { status: string }[] }>().tasks[0]?.status).toBe("done");
  });

  it("rejects unsupported or invalid sources", async () => {
    const { call } = await setup();
    expect(
      (await call("POST", "/api/v1/job-sources", { type: "workable", identifier: "x" })).statusCode,
    ).toBe(403);
    expect(
      (await call("POST", "/api/v1/job-sources", { type: "generic", identifier: "x" })).statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/v1/job-sources", {
          type: "lever",
          identifier: "http://evil.example.com",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", "/api/v1/job-sources", { type: "linkedin", identifier: "x" })).statusCode,
    ).toBe(400);
  });

  it("imports a job URL through the ATS API and refuses unsafe URLs", async () => {
    const { call, fx } = await setup();
    const ok = await call("POST", "/api/v1/jobs/import", {
      url: "https://boards.greenhouse.io/acmefictional/jobs/4012001",
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ job: { compensation: unknown; status: string } }>().job).toMatchObject({
      compensation: { min: 90000, currency: "EUR" },
      status: "ELIGIBLE",
    });
    const again = await call("POST", "/api/v1/jobs/import", {
      url: "https://boards.greenhouse.io/acmefictional/jobs/4012001",
    });
    expect(again.statusCode).toBe(200);
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "https://www.linkedin.com/jobs/view/1",
      "https://careers.example.com/jobs/1",
    ]) {
      const r = await call("POST", "/api/v1/jobs/import", { url });
      expect(r.statusCode, url).toBe(400);
    }
    expect(fx.calls.every((c) => c.startsWith("https://boards-api.greenhouse.io/"))).toBe(true);
  });

  it("only allows shortlist/skip/archive through the state machine", async () => {
    const { call } = await setup();
    await call("POST", "/api/v1/jobs/import", {
      url: "https://boards.greenhouse.io/acmefictional/jobs/4012001",
    });
    const id = "greenhouse:acmefictional/4012001";
    expect((await call("POST", "/api/v1/jobs/status", { id, to: "SHORTLISTED" })).statusCode).toBe(
      409,
    ); // ELIGIBLE must be scored first
    expect((await call("POST", "/api/v1/jobs/status", { id, to: "SUBMITTED" })).statusCode).toBe(
      400,
    );
    expect(
      (await call("POST", "/api/v1/jobs/status", { id: "greenhouse:none/1", to: "ARCHIVED" }))
        .statusCode,
    ).toBe(404);
  });

  it("queues scoring, serves match details with cited facts, and sorts by score", async () => {
    const { call, store, ownerId } = await setup();
    store.facts.add(ownerId, {
      category: "skill",
      claim: "TypeScript",
      source: "user-confirmed",
      verifiedAt: "2026-10-29T00:00:00.000Z",
      allowedTransformations: ["select"],
      sensitive: false,
    });
    await call("POST", "/api/v1/jobs/import", {
      url: "https://boards.greenhouse.io/acmefictional/jobs/4012001",
    });
    const id = "greenhouse:acmefictional/4012001";

    const before = await call("GET", `/api/v1/jobs/match?id=${encodeURIComponent(id)}`);
    expect(before.json()).toMatchObject({ match: null, scoring: false });

    const q = await call("POST", "/api/v1/jobs/score", { ids: [id, "greenhouse:none/1"] });
    expect(q.statusCode).toBe(202);
    expect(q.json()).toMatchObject({ queued: [id], skipped: ["greenhouse:none/1"] });
    expect((await call("POST", "/api/v1/jobs/score", { ids: [id] })).json()).toMatchObject({
      queued: [],
      skipped: [id],
    });
    expect(
      (await call("GET", `/api/v1/jobs/match?id=${encodeURIComponent(id)}`)).json(),
    ).toMatchObject({ scoring: true });

    // Stand-in for the worker.
    const { MatchingService } = await import("@career-agent/domain");
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
    const task = store.tasks.claim("w", 60_000);
    await matching.scoreJob(id, ownerId, "t");
    store.tasks.complete(task?.id ?? "", "w");

    const detail = (await call("GET", `/api/v1/jobs/match?id=${encodeURIComponent(id)}`)).json<{
      match: { total: number; requirements: { factIds: string[] }[] };
      stale: boolean;
      facts: Record<string, { claim: string }>;
    }>();
    expect(detail.stale).toBe(false);
    expect(detail.match.total).toBeGreaterThan(0);
    const cited = detail.match.requirements.flatMap((r) => r.factIds);
    expect(cited.length).toBeGreaterThan(0);
    for (const fid of cited) expect(detail.facts[fid]?.claim).toBe("TypeScript");

    const list = (await call("GET", "/api/v1/jobs?sort=score")).json<{
      jobs: { id: string; status: string; match: { verdict: string; stale: boolean } | null }[];
    }>();
    expect(list.jobs[0]).toMatchObject({ id, status: "SCORED", match: { stale: false } });
    expect((await call("POST", "/api/v1/jobs/status", { id, to: "SHORTLISTED" })).statusCode).toBe(
      200,
    );
    expect((await call("GET", "/api/v1/jobs?sort=bogus")).statusCode).toBe(400);
  });
});
