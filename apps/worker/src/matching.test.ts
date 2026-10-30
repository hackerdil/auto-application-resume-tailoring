import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMatchAnalyzer } from "@career-agent/ai";
import { createStore, type Store } from "@career-agent/db";
import {
  DiscoveryService,
  MatchingService,
  ProviderUnavailableError,
  SCORE_JOB_TASK,
  type MatchAnalyzer,
} from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import { FieldCipher } from "@career-agent/security";
import { createDiscoveryPorts, createSourceHttp, OriginScheduler } from "@career-agent/sources";
import { createFixtureHttp, FakeProvider } from "@career-agent/testkit";
import { enqueueScoring, Worker } from "./worker.js";

const LEVER = "https://api.lever.co/v0/postings/globexexample?mode=json";
const JOB_ID = "lever:globexexample/0b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
const now = new Date("2026-10-29T12:00:00Z");

function setup(
  analyzer: MatchAnalyzer | null = null,
  limits?: ConstructorParameters<typeof MatchingService>[0]["limits"],
) {
  const store: Store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k", { k: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const fx = createFixtureHttp({ [LEVER]: { file: "ats/lever-postings.json" } });
  const discovery = new DiscoveryService({
    jobs: store.jobs,
    sources: store.jobSources,
    fetches: store.jobFetches,
    profiles: store.profiles,
    audit: store.audit,
    ports: createDiscoveryPorts({
      http: createSourceHttp({
        get: fx.http,
        scheduler: new OriginScheduler(
          0,
          () => 0,
          () => Promise.resolve(),
        ),
      }),
      now: () => now,
    }),
    freshnessDays: 90,
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
    analyzer,
    ...(limits ? { limits } : {}),
    now: () => now,
  });
  const worker = new Worker({
    store,
    discovery,
    matching,
    ownerId,
    workerId: "w",
    logger: createLogger({ level: "silent" }),
    maxJobsScoredPerRun: 10,
  });
  const addFact = (claim: string, category: "skill" | "role" | "achievement" = "skill") =>
    store.facts.add(ownerId, {
      category,
      claim,
      source: "user-confirmed",
      verifiedAt: now.toISOString(),
      allowedTransformations: ["select"],
      sensitive: false,
    });
  return { store, ownerId, discovery, matching, worker, addFact };
}

async function discover(s: ReturnType<typeof setup>) {
  const src = s.discovery.addSource({ type: "lever", identifier: "globexexample" }, "t");
  s.store.tasks.enqueue(
    "discover_source",
    { sourceId: src.id, traceId: "t" },
    `discover:${src.id}:1`,
  );
  await s.worker.tick(); // discovery → queues scoring
}

describe("matching service", () => {
  it("discovery queues scoring; the worker scores deterministically and moves the job to SCORED", async () => {
    const s = setup();
    s.addFact("Kubernetes in production");
    s.addFact("Go");
    s.addFact("Senior Platform Engineer, Globex Example Inc", "role");
    s.store.profiles.save(s.ownerId, {
      fullName: { value: "Alex Example" },
      preferences: { targetRoles: ["Platform Engineer"], workModes: ["hybrid", "remote"] },
    });
    await discover(s);
    expect(s.store.tasks.listRecent(SCORE_JOB_TASK, 10)).toHaveLength(1);
    await s.worker.tick();
    const m = s.store.matches.latestForJob(JOB_ID);
    expect(m).toMatchObject({
      meta: {
        mode: "deterministic",
        modelSkippedReason: expect.stringMatching(/No AI provider/) as unknown,
      },
    });
    expect(m?.requirements.map((r) => [r.key, r.status])).toEqual([
      ["R1", "met"], // "Go or Rust" is satisfied by the "Go" fact
      ["R2", "met"],
      ["R3", "missing"],
    ]);
    expect(s.store.jobs.get(JOB_ID)?.status).toBe("SCORED");
    expect(s.store.jobRequirements.listForJob(JOB_ID).map((r) => r.key)).toEqual([
      "R1",
      "R2",
      "R3",
    ]);
    // Re-running discovery with unchanged content does not queue another scoring task.
    expect(enqueueScoring(s.store, [JOB_ID], "t", 10)).toEqual([]);
  });

  it("refuses to score filtered jobs", async () => {
    const s = setup();
    s.store.profiles.save(s.ownerId, {
      fullName: { value: "Alex Example" },
      preferences: { workModes: ["onsite"] },
    });
    await discover(s);
    await expect(s.matching.scoreJob(JOB_ID, s.ownerId, "t")).rejects.toThrow(/Only eligible jobs/);
  });

  it("uses validated model judgments and records provider runs", async () => {
    let goId = "";
    const provider = new FakeProvider([
      (req: { messages: { content: string }[] }) => {
        // The model sees fact ids; it must cite them, and only them.
        expect(req.messages[1]?.content).toContain(goId);
        return {
          requirements: [
            { key: "R1", status: "met", factIds: [goId], rationale: "Go is listed." },
            {
              key: "R2",
              status: "met",
              factIds: ["00000000-0000-7000-8000-000000000000"],
              rationale: "Hallucinated.",
            },
          ],
          explanation: "Some overlap.",
        };
      },
    ]);
    const s = setup(createMatchAnalyzer(provider));
    goId = s.addFact("Go").id;
    await discover(s);
    const scored = await s.matching.scoreJob(JOB_ID, s.ownerId, "t");
    expect(scored.meta.mode).toBe("model-assisted");
    expect(scored.requirements.find((r) => r.key === "R1")).toMatchObject({
      status: "met",
      source: "model",
      factIds: [goId],
    });
    expect(scored.requirements.find((r) => r.key === "R2")).toMatchObject({
      status: "unknown",
      factIds: [],
    });
    expect(scored.modelExplanation).toBe("Some overlap.");
    expect(
      s.store.sqlite.prepare("SELECT provider, task_type, prompt_id FROM provider_runs").all(),
    ).toEqual([{ provider: "openai", task_type: "match_scoring", prompt_id: "match-analysis" }]);
  });

  it("falls back to deterministic scoring when the provider fails or the budget is exceeded", async () => {
    const failing = setup(
      createMatchAnalyzer(new FakeProvider([new ProviderUnavailableError("openai", "down")])),
    );
    await discover(failing);
    const a = await failing.matching.scoreJob(JOB_ID, failing.ownerId, "t");
    expect(a.meta).toMatchObject({
      mode: "deterministic",
      modelSkippedReason: expect.stringMatching(/PROVIDER_UNAVAILABLE/) as unknown,
    });

    const costly = new FakeProvider([{ requirements: [], explanation: "" }]);
    const original = costly.run.bind(costly);
    costly.run = async (req) => {
      const r = await original(req);
      return { ...r, meta: { ...r.meta, costUsd: 5 } };
    };
    const capped = setup(createMatchAnalyzer(costly), {
      deadlineMs: 10_000,
      maxModelTurns: 2,
      maxToolCalls: 0,
      maxBrowserSteps: 0,
      maxRetries: 0,
      maxInputChars: 50_000,
      maxOutputTokens: 1000,
      maxCostUsd: 0.1,
    });
    await discover(capped);
    const b = await capped.matching.scoreJob(JOB_ID, capped.ownerId, "t");
    expect(b.meta.modelSkippedReason).toMatch(/maxCostUsd/);
  });

  it("detects stale scores when facts, profile, or sponsorship answers change", async () => {
    const s = setup();
    await discover(s);
    await s.worker.tick();
    const job = s.store.jobs.get(JOB_ID);
    const m = s.store.matches.latestForJob(JOB_ID);
    if (!job || !m) throw new Error("expected a scored job");
    expect(s.matching.isStale(s.ownerId, job, m)).toBe(false);
    s.addFact("Terraform");
    expect(s.matching.isStale(s.ownerId, job, m)).toBe(true);
    const fresh = await s.matching.scoreJob(JOB_ID, s.ownerId, "t");
    expect(fresh.requirements.find((r) => r.text === "Terraform")?.status).toBe("met");
    s.store.savedAnswers.save({
      userId: s.ownerId,
      normalizedQuestion: "do you require visa sponsorship",
      value: "yes",
      sensitivity: "sensitive",
    });
    expect(s.matching.isStale(s.ownerId, job, fresh)).toBe(true);
  });
});
