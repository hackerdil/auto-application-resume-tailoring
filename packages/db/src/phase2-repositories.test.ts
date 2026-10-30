import { describe, expect, it } from "vitest";
import { ConflictError, PolicyError, type NewFactCandidate } from "@career-agent/domain";
import { fixtureFact, testStore } from "./test-helpers.js";

const draft = {
  fullName: { value: "Alex Example", disclosure: "always" as const },
  email: { value: "alex.example@example.com", disclosure: "ask" as const },
  preferences: { targetRoles: ["Software Engineer"] },
};

const candidate = (over: Partial<NewFactCandidate> = {}): NewFactCandidate => ({
  category: "achievement",
  claim: "Reduced CI time from 30 to 12 minutes",
  evidenceText: "• Reduced CI time from 30 to 12 minutes",
  sourceLocation: "line 6",
  extractor: "deterministic",
  sensitive: false,
  ...over,
});

const setup = () => {
  const { store, clock } = testStore();
  const owner = store.users.ensureOwner("Alex Example");
  const art = store.artifacts.put({
    sha256: "d".repeat(64),
    mediaType: "application/pdf",
    byteSize: 1,
    kind: "resume",
    storagePath: "dd/x.pdf",
  });
  return { store, clock, owner, art };
};

describe("profiles", () => {
  it("versions every save and encrypts at rest", () => {
    const { store, owner, clock } = setup();
    expect(store.profiles.get(owner.id)).toBeNull();
    const v1 = store.profiles.save(owner.id, draft);
    clock.advance(1000);
    const v2 = store.profiles.save(owner.id, {
      ...draft,
      preferences: { targetRoles: ["Platform Engineer"] },
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.id).toBe(v1.id);
    expect(v2.createdAt).toBe(v1.createdAt);
    expect(store.profiles.get(owner.id)?.preferences.targetRoles).toEqual(["Platform Engineer"]);
    expect(store.profiles.listVersions(owner.id).map((v) => v.version)).toEqual([2, 1]);
    const raw =
      JSON.stringify(store.sqlite.prepare("SELECT * FROM candidate_profiles").all()) +
      JSON.stringify(store.sqlite.prepare("SELECT * FROM profile_versions").all());
    expect(raw).not.toContain("alex.example");
    expect(() => store.sqlite.prepare("UPDATE profile_versions SET version = 9").run()).toThrow(
      /immutable/,
    );
  });

  it("applies schema defaults and rejects invalid drafts", () => {
    const { store, owner } = setup();
    const p = store.profiles.save(owner.id, {
      fullName: { value: "Alex Example" },
      preferences: {},
    });
    expect(p.fullName.disclosure).toBe("ask");
    expect(p.preferences.workModes).toEqual([]);
    expect(() =>
      store.profiles.save(owner.id, { ...draft, email: { value: "not-an-email" } }),
    ).toThrow();
  });
});

describe("fact candidates", () => {
  it("are encrypted, listed by status, and decided exactly once", () => {
    const { store, owner, art } = setup();
    const [a, b] = store.candidates.addMany(owner.id, art.id, [
      candidate(),
      candidate({
        claim: "Maintained Python data pipelines",
        evidenceText: "- Maintained Python data pipelines",
      }),
    ]);
    if (!a || !b) throw new Error("expected two candidates");
    expect(
      JSON.stringify(store.sqlite.prepare("SELECT * FROM fact_candidates").all()),
    ).not.toContain("Reduced CI");
    expect(store.candidates.list(owner.id, "pending")).toHaveLength(2);

    const fact = store.facts.add(owner.id, fixtureFact());
    store.candidates.decide(a.id, { status: "confirmed", factId: fact.id });
    store.candidates.decide(b.id, { status: "rejected" });
    expect(store.candidates.list(owner.id, "pending")).toHaveLength(0);
    expect(store.candidates.get(a.id)?.factId).toBe(fact.id);
    expect(() => store.candidates.decide(a.id, { status: "rejected" })).toThrow(ConflictError);
    expect(() =>
      store.sqlite
        .prepare("UPDATE fact_candidates SET status = 'pending', fact_id = NULL, decided_at = NULL")
        .run(),
    ).toThrow(/final/);
  });

  it("enforce decision consistency in SQL", () => {
    const { store, owner, art } = setup();
    const [a] = store.candidates.addMany(owner.id, art.id, [candidate()]);
    expect(() =>
      store.sqlite
        .prepare("UPDATE fact_candidates SET status = 'confirmed' WHERE id = ?")
        .run(a?.id),
    ).toThrow(/CHECK/);
  });

  it("require an encryption key", () => {
    const { store } = testStore({ cipher: null });
    expect(() => store.candidates.addMany("x", "y", [candidate()])).toThrow(PolicyError);
  });
});

describe("document texts", () => {
  it("store encrypted text once per artifact", () => {
    const { store, art } = setup();
    store.documentTexts.put(art.id, "Alex Example résumé text");
    store.documentTexts.put(art.id, "something else");
    expect(store.documentTexts.get(art.id)).toBe("Alex Example résumé text");
    expect(
      JSON.stringify(store.sqlite.prepare("SELECT * FROM document_texts").all()),
    ).not.toContain("résumé");
  });
});

describe("idempotency keys", () => {
  it("replay the stored response and reject key reuse for a different request", () => {
    const { store } = setup();
    expect(store.idempotency.lookup("k1", "POST /facts", "h1")).toBeNull();
    store.idempotency.save("k1", "POST /facts", "h1", { statusCode: 201, body: { id: "f1" } });
    expect(store.idempotency.lookup("k1", "POST /facts", "h1")).toEqual({
      statusCode: 201,
      body: { id: "f1" },
    });
    expect(() => store.idempotency.lookup("k1", "POST /facts", "h2")).toThrow(ConflictError);
    expect(store.idempotency.lookup("k1", "POST /other", "h1")).toBeNull();
  });
});
