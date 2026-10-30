import { describe, expect, it } from "vitest";
import { uuidv7 } from "@career-agent/domain";
import { fixtureFact, fixtureJob, testStore } from "./test-helpers.js";

/** Invariants enforced by SQLite itself, so they hold even for code that bypasses repositories. */
describe("database guards", () => {
  const setup = () => {
    const { store, clock } = testStore();
    const owner = store.users.ensureOwner("Alex Example");
    store.jobs.upsert(fixtureJob());
    const app = store.applications.create(owner.id, fixtureJob().id, "t1");
    return { store, clock, owner, app };
  };

  it("audit events cannot be updated or deleted", () => {
    const { store } = setup();
    expect(() => store.sqlite.prepare("UPDATE audit_events SET type = 'x.y'").run()).toThrow(
      /append-only/,
    );
    expect(() => store.sqlite.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });

  it("artifacts are immutable", () => {
    const { store } = setup();
    store.artifacts.put({
      sha256: "a".repeat(64),
      mediaType: "application/pdf",
      byteSize: 1,
      kind: "resume",
      storagePath: "aa/x.pdf",
    });
    expect(() => store.sqlite.prepare("UPDATE artifacts SET byte_size = 2").run()).toThrow(
      /immutable/,
    );
  });

  it("facts only allow superseded_by to be set once, to an existing fact of the same owner", () => {
    const { store, owner } = setup();
    const a = store.facts.add(owner.id, fixtureFact());
    const b = store.facts.add(owner.id, fixtureFact({ claim: "Other" }));
    const q = (sql: string, ...p: unknown[]) => store.sqlite.prepare(sql).run(...p);
    expect(() => q("UPDATE facts SET claim = 'Led a team of 50' WHERE id = ?", a.id)).toThrow(
      /append-only/,
    );
    expect(() => q("UPDATE facts SET superseded_by = ? WHERE id = ?", uuidv7(), a.id)).toThrow(
      /append-only/,
    );
    expect(() => q("UPDATE facts SET superseded_by = ? WHERE id = ?", a.id, a.id)).toThrow(
      /append-only/,
    );
    expect(() => q("DELETE FROM facts WHERE id = ?", a.id)).toThrow(/append-only/);
    q("UPDATE facts SET superseded_by = ? WHERE id = ?", b.id, a.id);
    expect(() => q("UPDATE facts SET superseded_by = NULL WHERE id = ?", a.id)).toThrow(
      /append-only/,
    );
  });

  it("only one local owner exists", () => {
    const { store, owner } = setup();
    expect(store.users.ensureOwner("Someone Else").id).toBe(owner.id);
    expect(() =>
      store.sqlite.prepare("INSERT INTO users VALUES (?, 'x', 0)").run(uuidv7()),
    ).toThrow(/one local owner/);
  });

  it("terminal application states cannot change, and unknown states are rejected", () => {
    const { store, app } = setup();
    expect(() =>
      store.sqlite.prepare("UPDATE applications SET state = 'BOGUS' WHERE id = ?").run(app.id),
    ).toThrow(/CHECK/);
    store.sqlite.prepare("UPDATE applications SET state = 'SUBMITTED' WHERE id = ?").run(app.id);
    expect(() =>
      store.sqlite.prepare("UPDATE applications SET state = 'SUBMITTING' WHERE id = ?").run(app.id),
    ).toThrow(/terminal/);
  });

  it("approvals: one active per application, single-use, never reactivated", () => {
    const { store, app } = setup();
    const ins = store.sqlite.prepare(
      "INSERT INTO application_approvals (id, application_id, token_hash, binding_json, binding_mac, issued_at, expires_at) VALUES (?, ?, 'h', '{}', 'm', 0, 1000)",
    );
    const first = uuidv7();
    ins.run(first, app.id);
    expect(() => ins.run(uuidv7(), app.id)).toThrow(/UNIQUE/);
    const consume = store.sqlite.prepare(
      "UPDATE application_approvals SET consumed_at = 5 WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
    );
    expect(consume.run(first).changes).toBe(1);
    expect(consume.run(first).changes).toBe(0); // replay affects zero rows
    expect(() =>
      store.sqlite
        .prepare("UPDATE application_approvals SET consumed_at = NULL WHERE id = ?")
        .run(first),
    ).toThrow(/single-use/);
    expect(() =>
      store.sqlite
        .prepare("UPDATE application_approvals SET revoked_at = 6 WHERE id = ?")
        .run(first),
    ).toThrow(/single-use/);
    ins.run(uuidv7(), app.id); // a new approval is allowed once the previous one is consumed
  });

  it("answer constraints: prohibited fields stay empty, requires_user only finalized by the user", () => {
    const { store, app } = setup();
    const fieldId = uuidv7();
    store.sqlite
      .prepare(
        "INSERT INTO application_fields (id, application_id, field_key, label, normalized_question, type, required, options, snapshot_generation, created_at) VALUES (?, ?, 'eeo_gender', 'Gender', 'gender', 'select', 0, '[]', 1, 0)",
      )
      .run(fieldId, app.id);
    const ins = store.sqlite.prepare(
      "INSERT INTO application_answers (id, field_id, final_value_enc, final_value_set_by, provenance, confidence, sensitivity, decision, reviewer_changes, updated_at) VALUES (?, ?, ?, ?, '{}', 1, 'protected', ?, '[]', 0)",
    );
    expect(() => ins.run(uuidv7(), fieldId, "v1:x", "user", "prohibited")).toThrow(/CHECK/);
    expect(() => ins.run(uuidv7(), fieldId, "v1:x", "system", "requires_user")).toThrow(/CHECK/);
    expect(() => ins.run(uuidv7(), fieldId, "v1:x", "system", "needs_review")).toThrow(
      /finalized by the user/,
    );
    ins.run(uuidv7(), fieldId, "v1:x", "user", "requires_user");
    expect(() =>
      store.sqlite.prepare("UPDATE application_fields SET label = 'Changed'").run(),
    ).toThrow(/immutable/);
  });

  it("enforces foreign keys", () => {
    const { store, owner } = setup();
    expect(() => store.applications.create(owner.id, "greenhouse:missing", "t")).toThrow();
  });

  it("tailored bullets must reference at least one fact", () => {
    const { store } = setup();
    const rv = uuidv7();
    store.sqlite
      .prepare(
        "INSERT INTO resume_versions (id, profile_version, structured, status, created_at) VALUES (?, 1, '{}', 'draft', 0)",
      )
      .run(rv);
    const ins = store.sqlite.prepare(
      "INSERT INTO resume_bullets VALUES (?, ?, ?, 'text', ?, '[]', 'rephrase', 'pending', 'pending', '[]')",
    );
    expect(() => ins.run(uuidv7(), rv, 0, "[]")).toThrow(/CHECK/);
    ins.run(uuidv7(), rv, 1, JSON.stringify([uuidv7()]));
  });
});
