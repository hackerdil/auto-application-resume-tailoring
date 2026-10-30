import { describe, expect, it } from "vitest";
import { ConflictError, InvalidTransitionError, PolicyError } from "@career-agent/domain";
import { fixtureFact, fixtureJob, testStore } from "./test-helpers.js";

const ctx = (over: Record<string, unknown> = {}) => ({
  actor: "system" as const,
  mode: "review-each" as const,
  traceId: "trace-1",
  ...over,
});

describe("facts", () => {
  it("supersedes atomically and lists only active facts", () => {
    const { store } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    const a = store.facts.add(owner.id, fixtureFact());
    const b = store.facts.supersede(
      owner.id,
      a.id,
      fixtureFact({ claim: "Wrote production TypeScript and Go services" }),
    );
    expect(store.facts.get(a.id)?.supersededBy).toBe(b.id);
    expect(store.facts.listActive(owner.id).map((f) => f.id)).toEqual([b.id]);
    expect(() => store.facts.supersede(owner.id, a.id, fixtureFact())).toThrow(PolicyError);
  });

  it("encrypts sensitive facts at rest and fails closed without a key", () => {
    const { store } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    const f = store.facts.add(
      owner.id,
      fixtureFact({
        category: "work_authorization",
        claim: "Authorized to work in the EU",
        evidenceText: "Stated by user",
        sensitive: true,
      }),
    );
    const raw = store.sqlite
      .prepare("SELECT claim, evidence_text FROM facts WHERE id = ?")
      .get(f.id) as Record<string, string>;
    expect(raw["claim"]).not.toContain("Authorized");
    expect(raw["evidence_text"]).not.toContain("Stated");
    expect(store.facts.get(f.id)?.claim).toBe("Authorized to work in the EU");

    const noKey = testStore({ cipher: null }).store;
    const o2 = noKey.users.ensureOwner("Alex Example");
    expect(() => noKey.facts.add(o2.id, fixtureFact({ sensitive: true }))).toThrow(PolicyError);
    expect(noKey.facts.add(o2.id, fixtureFact()).claim).toBe(fixtureFact().claim);
  });

  it("validates input with the domain schema", () => {
    const { store } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    expect(() => store.facts.add(owner.id, fixtureFact({ allowedTransformations: [] }))).toThrow();
  });
});

describe("saved answers", () => {
  it("are encrypted, unique while active, and revocable", () => {
    const { store } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    const a = store.savedAnswers.save({
      userId: owner.id,
      normalizedQuestion: "salary expectation",
      value: "EUR 70000",
      sensitivity: "sensitive",
    });
    const raw = store.sqlite.prepare("SELECT value_enc FROM saved_answers").get() as {
      value_enc: string;
    };
    expect(raw.value_enc).not.toContain("70000");
    expect(store.savedAnswers.findActive(owner.id, "salary expectation")?.value).toBe("EUR 70000");
    expect(() =>
      store.savedAnswers.save({
        userId: owner.id,
        normalizedQuestion: "salary expectation",
        value: "x",
        sensitivity: "sensitive",
      }),
    ).toThrow(ConflictError);
    store.savedAnswers.revoke(a.id);
    expect(store.savedAnswers.findActive(owner.id, "salary expectation")).toBeNull();
    store.savedAnswers.save({
      userId: owner.id,
      normalizedQuestion: "salary expectation",
      value: "EUR 75000",
      sensitivity: "sensitive",
    });
  });

  it("refuse to store anything without an encryption key", () => {
    const { store } = testStore({ cipher: null });
    const owner = store.users.ensureOwner("Alex Example");
    expect(() =>
      store.savedAnswers.save({
        userId: owner.id,
        normalizedQuestion: "q",
        value: "v",
        sensitivity: "none",
      }),
    ).toThrow(PolicyError);
  });
});

describe("jobs", () => {
  it("dedupes by canonical id and detects content changes", () => {
    const { store } = testStore();
    expect(store.jobs.upsert(fixtureJob()).outcome).toBe("created");
    expect(store.jobs.upsert(fixtureJob({ lastSeenAt: "2026-10-30T00:00:00.000Z" })).outcome).toBe(
      "unchanged",
    );
    store.jobs.transition(fixtureJob().id, "NORMALIZED", { traceId: "t", actor: "system" });
    const changed = store.jobs.upsert(
      fixtureJob({ descriptionText: "New text", contentHash: "b".repeat(64) }),
    );
    expect(changed.outcome).toBe("updated");
    expect(changed.job.status).toBe("NORMALIZED"); // status preserved across re-discovery
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });

  it("transitions with an audit event and rejects invalid edges without side effects", () => {
    const { store } = testStore();
    store.jobs.upsert(fixtureJob());
    expect(() =>
      store.jobs.transition(fixtureJob().id, "SCORED", { traceId: "t", actor: "system" }),
    ).toThrow(InvalidTransitionError);
    expect(store.jobs.get(fixtureJob().id)?.status).toBe("DISCOVERED");
    store.jobs.transition(fixtureJob().id, "NORMALIZED", { traceId: "t", actor: "system" });
    const events = store.sqlite
      .prepare("SELECT type, prev_state, new_state FROM audit_events")
      .all();
    expect(events).toEqual([
      { type: "job.transition", prev_state: "DISCOVERED", new_state: "NORMALIZED" },
    ]);
  });
});

describe("artifacts", () => {
  it("are content-addressed and idempotent", () => {
    const { store } = testStore();
    const rec = {
      sha256: "c".repeat(64),
      mediaType: "application/pdf",
      byteSize: 10,
      kind: "resume",
      storagePath: "cc/x.pdf",
    };
    const a = store.artifacts.put(rec);
    expect(store.artifacts.put(rec).id).toBe(a.id);
    expect(store.artifacts.getBySha256(rec.sha256)?.id).toBe(a.id);
    expect(() => store.artifacts.put({ ...rec, sha256: "../etc" })).toThrow();
  });
});

describe("applications", () => {
  const setup = () => {
    const { store, clock } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    store.jobs.upsert(fixtureJob());
    const app = store.applications.create(owner.id, fixtureJob().id, "trace-1");
    return { store, clock, owner, app };
  };

  it("prevents duplicate applications for the same job", () => {
    const { store, owner } = setup();
    expect(() => store.applications.create(owner.id, fixtureJob().id, "t")).toThrow(ConflictError);
  });

  it("writes every transition and its audit event together", () => {
    const { store, app } = setup();
    store.applications.transition(app.id, "TAILORING", ctx());
    store.applications.transition(app.id, "VERIFYING", ctx());
    store.applications.transition(app.id, "READY_TO_PREPARE", ctx({ artifactsVerified: true }));
    const events = store.audit.listForApplication(app.id);
    expect(events.map((e) => [e.type, e.prevState, e.newState])).toEqual([
      ["application.created", null, "DRAFT"],
      ["application.transition", "DRAFT", "TAILORING"],
      ["application.transition", "TAILORING", "VERIFYING"],
      ["application.transition", "VERIFYING", "READY_TO_PREPARE"],
    ]);
    expect(events.every((e) => e.traceId.length > 0)).toBe(true);
  });

  it("a failed guard changes nothing and writes no audit event", () => {
    const { store, app } = setup();
    store.applications.transition(app.id, "TAILORING", ctx());
    store.applications.transition(app.id, "VERIFYING", ctx());
    expect(() =>
      store.applications.transition(app.id, "READY_TO_PREPARE", ctx({ artifactsVerified: false })),
    ).toThrow(InvalidTransitionError);
    expect(store.applications.get(app.id)?.state).toBe("VERIFYING");
    expect(store.audit.listForApplication(app.id)).toHaveLength(3);
  });

  it("rolls back the state change if the audit insert fails", () => {
    const { store, app } = setup();
    store.sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
    expect(() => store.applications.transition(app.id, "TAILORING", ctx())).toThrow(/audit down/);
    expect(store.applications.get(app.id)?.state).toBe("DRAFT");
  });

  it("model actors cannot approve or submit through the repository", () => {
    const { store, app } = setup();
    expect(() =>
      store.applications.transition(app.id, "WITHDRAWN", ctx({ actor: "openai" })),
    ).toThrow(InvalidTransitionError);
  });
});

describe("tasks", () => {
  it("enqueue is idempotent by key", () => {
    const { store } = testStore();
    const a = store.tasks.enqueue(
      "discover",
      { source: "greenhouse" },
      "discover:greenhouse:2026-10-29",
    );
    const b = store.tasks.enqueue(
      "discover",
      { source: "other" },
      "discover:greenhouse:2026-10-29",
    );
    expect(b.id).toBe(a.id);
    expect(b.payload).toEqual({ source: "greenhouse" });
  });

  it("leases tasks, reclaims expired leases, and resumes after a worker crash", () => {
    const { store, clock } = testStore();
    const t = store.tasks.enqueue("score", {}, "k1");
    const claimed = store.tasks.claim("w1", 1000);
    expect(claimed?.id).toBe(t.id);
    expect(store.tasks.claim("w2", 1000)).toBeNull();
    clock.advance(1001); // w1 crashed; lease expires
    const reclaimed = store.tasks.claim("w2", 1000);
    expect(reclaimed?.leaseOwner).toBe("w2");
    expect(reclaimed?.attempts).toBe(2);
    expect(() => {
      store.tasks.complete(t.id, "w1");
    }).toThrow(ConflictError);
    store.tasks.complete(t.id, "w2");
    expect(store.tasks.claim("w3", 1000)).toBeNull();
  });

  it("retries with backoff up to the attempt limit", () => {
    const { store, clock } = testStore();
    const t = store.tasks.enqueue("score", {}, "k2");
    store.tasks.claim("w", 1000);
    store.tasks.fail(t.id, "w", { retry: true, maxAttempts: 2 });
    expect(store.tasks.claim("w", 1000)).toBeNull(); // backoff not elapsed
    clock.advance(2000);
    expect(store.tasks.claim("w", 1000)?.attempts).toBe(2);
    store.tasks.fail(t.id, "w", { retry: true, maxAttempts: 2 });
    clock.advance(120_000);
    expect(store.tasks.claim("w", 1000)).toBeNull(); // exhausted → failed
  });

  it("needs_human tasks are never re-leased (ambiguous submissions)", () => {
    const { store, clock } = testStore();
    const t = store.tasks.enqueue("submit", {}, "k3");
    store.tasks.claim("w", 1000);
    store.tasks.markNeedsHuman(t.id, "w");
    clock.advance(10 * 60_000);
    expect(store.tasks.claim("w", 1000)).toBeNull();
  });
});
