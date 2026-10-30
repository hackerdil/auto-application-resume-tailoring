import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  FactBankService,
  NotFoundError,
  ProfileService,
  type DocumentPorts,
} from "@career-agent/domain";
import { sha256Hex } from "@career-agent/security";
import { assertSafeDeletionTarget, deleteLocalData, exportAllData } from "./local-data.js";
import { testStore } from "./test-helpers.js";

const TEXT = "Alex Example\n• Reduced CI time from 30 to 12 minutes\nSkills: TypeScript";

function ports(over: Partial<DocumentPorts> = {}): DocumentPorts {
  return {
    parse: (buf) =>
      Promise.resolve({
        kind: "pdf",
        mediaType: "application/pdf",
        sha256: sha256Hex(buf),
        byteSize: buf.length,
        pageCount: 1,
        text: TEXT,
        warnings: [],
      }),
    store: (buf, ext) => ({ sha256: sha256Hex(buf), storagePath: `xx/${sha256Hex(buf)}.${ext}` }),
    extract: () =>
      Promise.resolve({
        candidates: [
          {
            category: "achievement",
            claim: "Reduced CI time from 30 to 12 minutes",
            evidenceText: "• Reduced CI time from 30 to 12 minutes",
            sourceLocation: "line 2",
            extractor: "deterministic",
            sensitive: false,
          },
          {
            category: "skill",
            claim: "TypeScript",
            evidenceText: "Skills: TypeScript",
            sourceLocation: "line 3",
            extractor: "deterministic",
            sensitive: false,
          },
        ],
        rejected: 0,
        modelUsed: false,
        warnings: [],
      }),
    ...over,
  };
}

function setup(p = ports()) {
  const { store } = testStore();
  const owner = store.users.ensureOwner("Alex Example");
  const bank = new FactBankService({
    uow: store,
    facts: store.facts,
    candidates: store.candidates,
    documentTexts: store.documentTexts,
    artifacts: store.artifacts,
    audit: store.audit,
    documents: p,
  });
  return { store, owner, bank };
}

describe("FactBankService", () => {
  it("imports a résumé as pending suggestions, never as facts", async () => {
    const { store, owner, bank } = setup();
    const r = await bank.importResume(owner.id, Buffer.from("pdf bytes"), "t1");
    expect(r.candidates).toHaveLength(2);
    expect(bank.listFacts(owner.id)).toHaveLength(0);
    expect(store.documentTexts.get(r.artifactId)).toBe(TEXT);
    const ev = store.sqlite
      .prepare("SELECT type, metadata, artifact_hashes FROM audit_events")
      .get() as Record<string, string>;
    expect(ev["type"]).toBe("document.imported");
    expect(ev["metadata"]).not.toContain("Reduced CI"); // no content in audit metadata
    expect(JSON.parse(ev["artifact_hashes"] ?? "[]")).toEqual([r.sha256]);
  });

  it("re-importing the same file is idempotent", async () => {
    const { owner, bank } = setup();
    const a = await bank.importResume(owner.id, Buffer.from("same"), "t1");
    const b = await bank.importResume(owner.id, Buffer.from("same"), "t2");
    expect(b.alreadyImported).toBe(true);
    expect(b.candidates.map((c) => c.id)).toEqual(a.candidates.map((c) => c.id));
  });

  it("confirms with provenance; edits become user-confirmed but keep the résumé evidence", async () => {
    const { owner, bank } = setup();
    const r = await bank.importResume(owner.id, Buffer.from("x"), "t");
    const [first, second] = r.candidates;
    if (!first || !second) throw new Error("expected candidates");
    const kept = bank.confirmCandidate(owner.id, first.id, {}, "t");
    expect(kept).toMatchObject({
      source: "resume",
      sourceArtifactId: r.artifactId,
      sourceLocation: "line 2",
      evidenceText: first.evidenceText,
    });
    const edited = bank.confirmCandidate(
      owner.id,
      second.id,
      { claim: "TypeScript (5 years)" },
      "t",
    );
    expect(edited).toMatchObject({ source: "user-confirmed", evidenceText: "Skills: TypeScript" });
    expect(bank.listCandidates(owner.id)).toHaveLength(0);
    expect(() => bank.confirmCandidate(owner.id, first.id, {}, "t")).toThrow(ConflictError);
    expect(bank.listFacts(owner.id)).toHaveLength(2); // the failed second confirm created nothing
  });

  it("rejects and corrects; corrections supersede", async () => {
    const { owner, bank } = setup();
    const r = await bank.importResume(owner.id, Buffer.from("x"), "t");
    const [first, second] = r.candidates;
    if (!first || !second) throw new Error("expected candidates");
    bank.rejectCandidate(owner.id, second.id, "t");
    const f = bank.confirmCandidate(owner.id, first.id, {}, "t");
    const corrected = bank.correctFact(
      owner.id,
      f.id,
      { claim: "Reduced CI time from 30 to 12 minutes at Acme Fictional" },
      "t",
    );
    expect(bank.listFacts(owner.id).map((x) => x.id)).toEqual([corrected.id]);
    expect(corrected.evidenceText).toBe(f.evidenceText);
  });

  it("hides other owners' suggestions and validates input", async () => {
    const { owner, bank } = setup();
    expect(() =>
      bank.confirmCandidate(owner.id, "0190f0b0-0000-7000-8000-000000000009", {}, "t"),
    ).toThrow(NotFoundError);
    const r = await bank.importResume(owner.id, Buffer.from("x"), "t");
    expect(() => bank.confirmCandidate("someone-else", r.candidates[0]?.id ?? "", {}, "t")).toThrow(
      NotFoundError,
    );
    expect(() =>
      bank.confirmCandidate(owner.id, r.candidates[0]?.id ?? "", { claim: "   " }, "t"),
    ).toThrow(/empty/);
  });

  it("rolls back the fact when the audit write fails", async () => {
    const { store, owner, bank } = setup();
    const r = await bank.importResume(owner.id, Buffer.from("x"), "t");
    store.sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
    expect(() => bank.confirmCandidate(owner.id, r.candidates[0]?.id ?? "", {}, "t")).toThrow(
      /audit down/,
    );
    expect(bank.listFacts(owner.id)).toHaveLength(0);
    expect(bank.listCandidates(owner.id)).toHaveLength(2);
  });

  it("propagates parse errors without storing anything", async () => {
    const { store, owner, bank } = setup(
      ports({ parse: () => Promise.reject(new Error("bad file")) }),
    );
    await expect(bank.importResume(owner.id, Buffer.from("x"), "t")).rejects.toThrow("bad file");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
  });
});

describe("ProfileService", () => {
  it("replaces saved answers for the same normalized question", () => {
    const { store, owner } = setup();
    const svc = new ProfileService({
      uow: store,
      profiles: store.profiles,
      savedAnswers: store.savedAnswers,
      audit: store.audit,
    });
    svc.saveAnswer(
      owner.id,
      { question: "Do you require visa sponsorship?", value: "No", sensitivity: "sensitive" },
      "t",
    );
    svc.saveAnswer(
      owner.id,
      { question: "do you require VISA sponsorship", value: "Yes", sensitivity: "sensitive" },
      "t",
    );
    expect(store.savedAnswers.listActive(owner.id).map((a) => a.value)).toEqual(["Yes"]);
  });
});

describe("export and deletion", () => {
  it("exports decrypted user data", async () => {
    const { store, owner, bank } = setup();
    const r = await bank.importResume(owner.id, Buffer.from("x"), "t");
    bank.confirmCandidate(owner.id, r.candidates[0]?.id ?? "", {}, "t");
    const out = exportAllData(store, owner.id);
    expect(out.facts[0]?.claim).toBe("Reduced CI time from 30 to 12 minutes");
    expect(out.pendingSuggestions).toHaveLength(1);
    expect(out.auditEvents.length).toBeGreaterThan(0);
  });

  it("deletes the database and directory contents but keeps .gitkeep", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ca-del-"));
    const dbFile = path.join(root, "data", "db.sqlite");
    const art = path.join(root, "artifacts");
    mkdirSync(path.join(art, "ab"), { recursive: true });
    mkdirSync(path.dirname(dbFile), { recursive: true });
    for (const f of [
      dbFile,
      `${dbFile}-wal`,
      path.join(art, ".gitkeep"),
      path.join(art, "ab", "x.pdf"),
    ])
      writeFileSync(f, "x");
    const removed = deleteLocalData({
      databaseFile: dbFile,
      directories: [art, path.join(root, "missing")],
    });
    expect(removed).toHaveLength(3);
    expect(existsSync(dbFile)).toBe(false);
    expect(readdirSync(art)).toEqual([".gitkeep"]);
  });

  it.each(["/", homedir(), process.cwd(), "/tmp"])("refuses dangerous target %s", (p) => {
    expect(() => assertSafeDeletionTarget(p)).toThrow();
  });
});
