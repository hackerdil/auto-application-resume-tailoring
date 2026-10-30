import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@career-agent/config";
import { createStore } from "@career-agent/db";
import { createArtifactWriter, FileArtifactStore } from "@career-agent/documents";
import { canonicalJobId, TailoringService, type ResumeRenderer } from "@career-agent/domain";
import { createLogger } from "@career-agent/observability";
import { FieldCipher, sha256Hex } from "@career-agent/security";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app.js";
import { documentPorts } from "./documents.js";

const API = "127.0.0.1:3001";
const renderer: ResumeRenderer = {
  render: () =>
    Promise.resolve({
      html: "<p>r</p>",
      pdf: Buffer.from("%PDF-fake"),
      docx: Buffer.from("PKfake"),
      pageCount: 1,
      checks: [{ name: "pdf_text", ok: true, detail: "ok" }],
    }),
};

async function setup() {
  const config = loadConfig({ DATABASE_URL: ":memory:", LOG_LEVEL: "silent", NODE_ENV: "test" });
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k1", { k1: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const artifactDir = mkdtempSync(path.join(tmpdir(), "ca-res-"));
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
        "idempotency-key": `res-test-${++n}`,
      },
    };
    if (body !== undefined) opts.payload = body as NonNullable<InjectOptions["payload"]>;
    return app.inject(opts);
  };
  const jobId = canonicalJobId("lever", "acme/1");
  const now = "2026-10-29T12:00:00.000Z";
  store.jobs.upsert({
    id: jobId,
    source: "lever",
    externalId: "acme/1",
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
    requiredQualifications: ["TypeScript"],
    preferredQualifications: [],
    compensation: null,
    sponsorship: { value: "unknown", confidence: 0, evidence: null },
    postedAt: null,
    updatedAt: null,
    firstSeenAt: now,
    lastSeenAt: now,
    sourceHash: sha256Hex("a"),
    contentHash: sha256Hex("b"),
    status: "ELIGIBLE",
    filterReasons: [],
    removedFromSourceAt: null,
  });
  store.facts.add(ownerId, {
    category: "achievement",
    claim: "Built a TypeScript billing service",
    source: "user-confirmed",
    verifiedAt: now,
    allowedTransformations: ["select"],
    sensitive: false,
  });
  const files = new FileArtifactStore(artifactDir);
  const tailoring = new TailoringService({
    jobs: store.jobs,
    facts: store.facts,
    profiles: store.profiles,
    matches: store.matches,
    resumes: store.resumes,
    providerRuns: store.providerRuns,
    audit: store.audit,
    renderer,
    artifacts: createArtifactWriter(files, store.artifacts),
  });
  return { call, store, ownerId, jobId, tailoring, files };
}

describe("tailored résumé API", () => {
  it("queues tailoring once per job", async () => {
    const { call, jobId } = await setup();
    expect(
      (await call("POST", "/api/v1/tailored-resumes", { jobId, length: "one-page" })).json(),
    ).toMatchObject({ queued: true });
    expect((await call("POST", "/api/v1/tailored-resumes", { jobId })).json()).toMatchObject({
      queued: false,
      alreadyRunning: true,
    });
    expect(
      (await call("GET", `/api/v1/tailored-resumes?jobId=${encodeURIComponent(jobId)}`)).json(),
    ).toMatchObject({ resumes: [], tailoring: true });
    expect(
      (await call("POST", "/api/v1/tailored-resumes", { jobId: "lever:none/1" })).statusCode,
    ).toBe(404);
  });

  it("serves provenance, downloads rendered artifacts as attachments, and records decisions", async () => {
    const { call, store, ownerId, jobId, tailoring, files } = await setup();
    const rec = await tailoring.tailor(jobId, ownerId, "one-page", "t");
    const detail = (await call("GET", `/api/v1/tailored-resumes/detail?id=${rec.resume.id}`)).json<{
      provenance: { sources: { claim: string }[]; diff: unknown }[];
      status: string;
    }>();
    expect(detail.status).toBe("draft");
    expect(detail.provenance[0]).toMatchObject({
      sources: [{ claim: "Built a TypeScript billing service" }],
      diff: null,
    });

    const pdf = await call("GET", `/api/v1/artifacts/${rec.artifacts.pdf?.id ?? ""}/download`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toMatch(
      /^attachment; filename="resume-[0-9a-f]{12}\.pdf"$/,
    );
    expect(pdf.rawPayload.toString()).toBe("%PDF-fake");
    const html = await call("GET", `/api/v1/artifacts/${rec.artifacts.html?.id ?? ""}/download`);
    expect(html.headers["content-disposition"]).toMatch(/^attachment;/);

    // Source uploads are never served, and tampered files are refused.
    const src = store.artifacts.put({
      ...files.put(Buffer.from("orig"), "pdf"),
      mediaType: "application/pdf",
      byteSize: 4,
      kind: "resume_source",
    });
    expect((await call("GET", `/api/v1/artifacts/${src.id}/download`)).statusCode).toBe(403);
    const { writeFileSync } = await import("node:fs");
    const pdfRec = store.artifacts.get(rec.artifacts.pdf?.id ?? "");
    writeFileSync(
      path.join((files as unknown as { root: string }).root, pdfRec?.storagePath ?? ""),
      "tampered",
    );
    expect(
      (await call("GET", `/api/v1/artifacts/${rec.artifacts.pdf?.id ?? ""}/download`)).statusCode,
    ).toBe(400);

    expect(
      (await call("POST", `/api/v1/tailored-resumes/${rec.resume.id}/approve`)).json(),
    ).toMatchObject({ status: "approved" });
    expect(
      (await call("POST", `/api/v1/tailored-resumes/${rec.resume.id}/reject`)).statusCode,
    ).toBe(409);
  });
});
