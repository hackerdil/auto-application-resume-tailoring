import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@career-agent/config";
import { createStore } from "@career-agent/db";
import { canonicalJobId } from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import { FieldCipher, sha256Hex } from "@career-agent/security";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app.js";
import { documentPorts } from "./documents.js";

const API = "127.0.0.1:3001";

async function setup() {
  const config = loadConfig({ DATABASE_URL: ":memory:", LOG_LEVEL: "silent", NODE_ENV: "test" });
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k1", { k1: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const artifactDir = mkdtempSync(path.join(tmpdir(), "ca-apps-"));
  const app = await buildApp({
    config,
    store,
    ownerId,
    documents: documentPorts(artifactDir),
    artifactDir,
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
        "idempotency-key": `apps-test-${++n}`,
      },
    };
    if (body !== undefined) opts.payload = body as NonNullable<InjectOptions["payload"]>;
    return app.inject(opts);
  };
  const t = "2026-10-30T00:00:00.000Z";
  const job = (id: string, status: "SCORED" | "FILTERED") =>
    store.jobs.upsert({
      id,
      source: "lever",
      externalId: id.split(":")[1] ?? "x",
      sourceUrl: "https://jobs.lever.co/acme/1",
      applyUrl: null,
      company: "Acme",
      title: "Engineer",
      team: null,
      locations: [],
      workMode: "remote",
      employmentType: "unknown",
      seniority: "unknown",
      descriptionText: "",
      descriptionHtmlSanitized: null,
      requiredQualifications: [],
      preferredQualifications: [],
      compensation: null,
      sponsorship: { value: "unknown", confidence: 0, evidence: null },
      postedAt: null,
      updatedAt: null,
      firstSeenAt: t,
      lastSeenAt: t,
      sourceHash: sha256Hex(id),
      contentHash: sha256Hex(`c${id}`),
      status,
      filterReasons: [],
      removedFromSourceAt: null,
    });
  job(canonicalJobId("lever", "acme/1"), "SCORED");
  job(canonicalJobId("lever", "acme/2"), "FILTERED");
  return { call, store };
}

describe("applications API", () => {
  it("creates one application per job, adds questions, answers them, and refuses prohibited ones", async () => {
    const { call, store } = await setup();
    const jobId = canonicalJobId("lever", "acme/1");
    const created = await call("POST", "/api/v1/applications", { jobId });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ application: { id: string } }>().application.id;
    expect(
      (await call("POST", "/api/v1/applications", { jobId: canonicalJobId("lever", "acme/2") }))
        .statusCode,
    ).toBe(403);

    const added = await call("POST", `/api/v1/applications/${id}/questions`, {
      questions: [
        { label: "Gender", type: "select", options: ["Female", "Male", "Prefer not to say"] },
        { label: "I agree to the terms of service", type: "checkbox", required: true },
        { label: "Favourite colour", required: true },
      ],
    });
    const answers = added.json<{
      answers: { field: { id: string; label: string }; decision: string }[];
    }>().answers;
    expect(answers.map((a) => [a.field.label, a.decision])).toEqual([
      ["Gender", "requires_user"],
      ["I agree to the terms of service", "prohibited"],
      ["Favourite colour", "requires_user"],
    ]);
    const [gender, terms, colour] = answers;
    expect(
      (
        await call("POST", `/api/v1/applications/${id}/questions/${terms?.field.id ?? ""}/answer`, {
          value: "yes",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          `/api/v1/applications/${id}/questions/${gender?.field.id ?? ""}/answer`,
          { value: "Other" },
        )
      ).statusCode,
    ).toBe(400);
    const ok = await call(
      "POST",
      `/api/v1/applications/${id}/questions/${colour?.field.id ?? ""}/answer`,
      { value: "Teal" },
    );
    expect(
      ok.json<{ answersComplete: boolean; answers: { finalValue: string | null }[] }>().answers[2]
        ?.finalValue,
    ).toBe("Teal");

    const detail = await call("GET", `/api/v1/applications/detail?id=${id}`);
    expect(detail.json()).toMatchObject({
      application: { state: "DRAFT" },
      resumes: [],
      coverLetters: [],
      coverLetterDrafting: false,
    });
    expect(
      (await call("POST", `/api/v1/applications/${id}/cover-letter/draft`)).json(),
    ).toMatchObject({ queued: true });
    expect(
      (await call("POST", `/api/v1/applications/${id}/cover-letter/draft`)).json(),
    ).toMatchObject({ alreadyRunning: true });
    // Preparing in the browser needs approved materials; nothing is queued before that.
    expect(detail.json()).toMatchObject({ browser: { busy: false, session: null } });
    const early = await call("POST", `/api/v1/applications/${id}/browser/prepare`);
    expect(early.statusCode).toBe(403);
    expect(store.tasks.hasActive(`browser:${id}:`)).toBe(false);
    const close = await call("POST", `/api/v1/applications/${id}/browser/close`);
    expect(close.json()).toMatchObject({ queued: true });
    // Phase 8: approval needs an application ready for review, a live reviewed form, and explicit confirmation.
    expect(detail.json()).toMatchObject({ approval: { active: null, attempt: null } });
    expect((await call("POST", `/api/v1/applications/${id}/approve`, {})).statusCode).toBe(400);
    const approve = await call("POST", `/api/v1/applications/${id}/approve`, { confirm: true });
    expect(approve.statusCode).toBe(403);
    expect(store.approvals.active(id)).toBeNull();
    expect(
      (await call("POST", `/api/v1/applications/${id}/resolve`, { outcome: "submitted" }))
        .statusCode,
    ).toBe(403);
    expect((await call("POST", `/api/v1/applications/${id}/approval/revoke`)).json()).toMatchObject(
      {
        revoked: false,
      },
    );
    const drafts = await call("POST", `/api/v1/applications/${id}/draft-answers`);
    expect(drafts.json<{ note: string }>().note).toMatch(/No AI provider/);
    const list = await call("GET", "/api/v1/applications");
    expect(list.json<{ applications: { id: string; pending: number }[] }>().applications).toEqual([
      expect.objectContaining({ id }),
    ]);
    expect(
      (await call("GET", "/api/v1/applications/detail?id=0190f0b0-0000-7000-8000-000000000000"))
        .statusCode,
    ).toBe(404);
  });
});
