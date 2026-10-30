import { describe, expect, it } from "vitest";
import { ConflictError, uuidv7, type TailoredResume } from "@career-agent/domain";
import { testStore } from "./test-helpers.js";

function resume(): TailoredResume {
  return {
    id: uuidv7(),
    jobId: null,
    profileVersion: 1,
    length: "one-page",
    createdAt: "2026-10-29T12:00:00.000Z",
    header: { name: "Alex Example", contact: [], links: [] },
    summary: null,
    experience: [
      {
        roleFactId: null,
        heading: "Selected highlights",
        bullets: [
          {
            id: uuidv7(),
            text: "Built a billing service",
            sourceFactIds: [uuidv7()],
            targetRequirementKeys: [],
            transformation: "select",
            verifier: { deterministic: "pass", review: "unavailable", findings: [] },
          },
        ],
      },
    ],
    skills: [],
    education: [],
    certifications: [],
    projects: [],
    languages: [],
    dropped: [],
    omittedFactIds: [],
    meta: {
      mode: "deterministic",
      generator: null,
      reviewer: null,
      review: "unavailable",
      regenerated: 0,
      promptIds: [],
      notes: [],
    },
  };
}

describe("résumé versions", () => {
  const setup = () => {
    const { store } = testStore();
    const art = (sha: string) =>
      store.artifacts.put({
        sha256: sha.repeat(64),
        mediaType: "application/pdf",
        byteSize: 1,
        kind: "resume_pdf",
        storagePath: `${sha}${sha}/x.pdf`,
      });
    const ids = { html: art("a").id, pdf: art("b").id, docx: art("c").id };
    return { store, ids };
  };

  it("stores structured content, bullets, artifacts, and checks", () => {
    const { store, ids } = setup();
    const r = resume();
    const rec = store.resumes.create({
      resume: r,
      status: "draft",
      artifactIds: ids,
      checks: [{ name: "pdf_text", ok: true, detail: "ok" }],
    });
    expect(rec).toMatchObject({ status: "draft", artifacts: { pdf: { sha256: "b".repeat(64) } } });
    expect(store.sqlite.prepare("SELECT text FROM resume_bullets").all()).toEqual([
      { text: "Built a billing service" },
    ]);
  });

  it("is immutable except for one approve/reject decision on a draft", () => {
    const { store, ids } = setup();
    const r = resume();
    store.resumes.create({ resume: r, status: "draft", artifactIds: ids, checks: [] });
    expect(() =>
      store.sqlite.prepare("UPDATE resume_versions SET structured = '{}'").run(),
    ).toThrow(/immutable/);
    expect(() =>
      store.sqlite.prepare("UPDATE resume_bullets SET text = 'Led 50 people'").run(),
    ).toThrow(/immutable/);
    expect(() => store.sqlite.prepare("DELETE FROM resume_versions").run()).toThrow(/immutable/);
    expect(store.resumes.decide(r.id, "approved").status).toBe("approved");
    expect(() => store.resumes.decide(r.id, "rejected")).toThrow(ConflictError);
    expect(() => store.sqlite.prepare("UPDATE resume_versions SET status = 'draft'").run()).toThrow(
      /immutable/,
    );
  });

  it("cannot approve a version that failed render checks", () => {
    const { store, ids } = setup();
    const r = resume();
    store.resumes.create({
      resume: r,
      status: "needs_attention",
      artifactIds: ids,
      checks: [{ name: "pdf_text", ok: false, detail: "missing" }],
    });
    expect(() => store.resumes.decide(r.id, "approved")).toThrow(/needs attention/);
    expect(() =>
      store.sqlite
        .prepare(
          "INSERT INTO resume_versions (id, profile_version, structured, status, created_at) VALUES ('x', 1, '{}', 'published', 0)",
        )
        .run(),
    ).toThrow(/invalid resume status/);
  });
});
