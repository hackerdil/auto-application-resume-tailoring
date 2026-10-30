import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@career-agent/config";
import { createStore } from "@career-agent/db";
import { createLogger } from "@career-agent/observability";
import { FieldCipher } from "@career-agent/security";
import { FICTIONAL_RESUME_LINES, makeDocx, makePdf } from "@career-agent/testkit";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp } from "./app.js";
import { documentPorts } from "./documents.js";

const API = "127.0.0.1:3001";
const ORIGIN = "http://127.0.0.1:3000";

async function setup(opts: { now?: () => number; maxUploadBytes?: number } = {}) {
  const config = loadConfig({ DATABASE_URL: ":memory:", LOG_LEVEL: "silent", NODE_ENV: "test" });
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k1", { k1: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const app = await buildApp({
    config,
    store,
    ownerId,
    ...(() => {
      const artifactDir = mkdtempSync(path.join(tmpdir(), "ca-api-art-"));
      return { documents: documentPorts(artifactDir), artifactDir };
    })(),
    sessionSecret: randomBytes(32),
    logger: createLogger({ level: "silent" }),
    ...opts,
  });
  const s = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: API } });
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const csrf = s.json<{ csrfToken: string }>().csrfToken;
  let n = 0;
  const call = (
    method: NonNullable<InjectOptions["method"]>,
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> => {
    const opts: InjectOptions = {
      method,
      url,
      headers: {
        host: API,
        cookie,
        "x-csrf-token": csrf,
        origin: ORIGIN,
        "idempotency-key": `test-key-${++n}-${Date.now()}`,
        ...extra,
      },
    };
    if (body !== undefined) opts.payload = body as NonNullable<InjectOptions["payload"]>;
    return app.inject(opts);
  };
  return { app, store, ownerId, cookie, csrf, call, session: s };
}

function multipart(buf: Buffer, filename = "resume.pdf", type = "application/pdf") {
  const boundary = "----careeragenttest";
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("local-only transport", () => {
  it("serves health without a session", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: API } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("rejects non-loopback peers", async () => {
    const { app } = await setup();
    const r = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: API },
      remoteAddress: "203.0.113.7",
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({
      error: { code: "NOT_LOCAL", message: "Only local connections are accepted." },
    });
  });

  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const { app } = await setup();
    const r = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "evil.example.com:3001" },
    });
    expect(r.statusCode).toBe(421);
  });

  it("issues an HttpOnly SameSite=Strict session cookie", async () => {
    const { session } = await setup();
    const c = session.cookies[0];
    expect(c).toMatchObject({ name: "ca_session", httpOnly: true, sameSite: "Strict", path: "/" });
  });
});

describe("session, CSRF and idempotency", () => {
  it("requires a session for data endpoints", async () => {
    const { app } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/v1/facts", headers: { host: API } });
    expect(r.statusCode).toBe(401);
  });

  it("rejects forged or expired session cookies", async () => {
    let now = Date.now();
    const { app, cookie } = await setup({ now: () => now });
    const forged = cookie.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/facts",
          headers: { host: API, cookie: forged },
        })
      ).statusCode,
    ).toBe(401);
    now += 13 * 60 * 60 * 1000;
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/facts", headers: { host: API, cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it.each([
    ["missing CSRF token", { "x-csrf-token": "" }, 403],
    ["wrong CSRF token", { "x-csrf-token": "ab".repeat(32) }, 403],
    ["foreign origin", { origin: "https://evil.example.com" }, 403],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }, 403],
    ["missing idempotency key", { "idempotency-key": "" }, 400],
  ])("rejects mutations with %s", async (_name, headers, status) => {
    const { call } = await setup();
    const r = await call(
      "POST",
      "/api/v1/facts",
      { category: "skill", claim: "TypeScript" },
      headers,
    );
    expect(r.statusCode).toBe(status);
  });

  it("replays a retried request and rejects key reuse with a different body", async () => {
    const { call } = await setup();
    const headers = { "idempotency-key": "retry-key-0001" };
    const a = await call(
      "POST",
      "/api/v1/facts",
      { category: "skill", claim: "TypeScript" },
      headers,
    );
    const b = await call(
      "POST",
      "/api/v1/facts",
      { category: "skill", claim: "TypeScript" },
      headers,
    );
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.json()).toEqual(a.json());
    const facts = await call("GET", "/api/v1/facts");
    expect(facts.json<{ facts: unknown[] }>().facts).toHaveLength(1);
    const c = await call("POST", "/api/v1/facts", { category: "skill", claim: "Go" }, headers);
    expect(c.statusCode).toBe(409);
  });

  it("returns validation issues without internals", async () => {
    const { call } = await setup();
    const r = await call("POST", "/api/v1/facts", { category: "nonsense", claim: "" });
    expect(r.statusCode).toBe(400);
    const body = r.json<{ error: { code: string; issues: string[] } }>();
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.issues.join()).toMatch(/category/);
    expect(r.body).not.toMatch(/at .*\.ts|node_modules|stack/);
  });
});

describe("onboarding flow", () => {
  it("imports a résumé, confirms/edits/rejects suggestions, corrects a fact, and exports", async () => {
    const { call, app, cookie, csrf } = await setup();
    const up = multipart(makePdf([FICTIONAL_RESUME_LINES]));
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/resumes",
      headers: {
        host: API,
        cookie,
        "x-csrf-token": csrf,
        origin: ORIGIN,
        "idempotency-key": "upload-0001",
        "content-type": up.contentType,
      },
      payload: up.payload,
    });
    expect(imported.statusCode).toBe(201);
    const result = imported.json<{
      candidates: { id: string; claim: string; category: string }[];
      kind: string;
    }>();
    expect(result.kind).toBe("pdf");
    expect(result.candidates.length).toBeGreaterThan(5);

    const ci = result.candidates.find((c) => c.claim.startsWith("Reduced CI"));
    const py = result.candidates.find((c) => c.claim === "Python");
    if (!ci || !py) throw new Error("expected candidates");
    const confirmed = await call("POST", `/api/v1/fact-candidates/${ci.id}/confirm`, {});
    expect(confirmed.json<{ fact: { source: string } }>().fact.source).toBe("resume");
    const edited = await call("POST", `/api/v1/fact-candidates/${py.id}/confirm`, {
      claim: "Python (data pipelines)",
    });
    expect(edited.json<{ fact: { source: string } }>().fact.source).toBe("user-confirmed");
    const other = result.candidates.find((c) => c.id !== ci.id && c.id !== py.id);
    expect(
      (await call("POST", `/api/v1/fact-candidates/${other?.id ?? ""}/reject`)).statusCode,
    ).toBe(200);
    expect((await call("POST", `/api/v1/fact-candidates/${ci.id}/confirm`, {})).statusCode).toBe(
      409,
    );

    const facts = (await call("GET", "/api/v1/facts")).json<{
      facts: { id: string; claim: string }[];
    }>().facts;
    expect(facts).toHaveLength(2);
    const target = facts.find((f) => f.claim.startsWith("Reduced CI"));
    const corrected = await call("POST", `/api/v1/facts/${target?.id ?? ""}/corrections`, {
      claim: "Reduced CI time from 30 to 12 minutes at Acme Fictional",
    });
    expect(corrected.statusCode).toBe(201);
    expect((await call("GET", "/api/v1/facts")).json<{ facts: unknown[] }>().facts).toHaveLength(2);

    const exp = await call("GET", "/api/v1/export");
    expect(exp.headers["content-disposition"]).toMatch(
      /attachment; filename="career-agent-export-/,
    );
    expect(exp.json<{ facts: unknown[] }>().facts).toHaveLength(3); // includes the superseded version
  });

  it("accepts DOCX and rejects unsupported or oversized files", async () => {
    const { app, cookie, csrf } = await setup({ maxUploadBytes: 64 * 1024 });
    const send = (buf: Buffer, key: string, name = "r.docx") => {
      const up = multipart(buf, name);
      return app.inject({
        method: "POST",
        url: "/api/v1/resumes",
        headers: {
          host: API,
          cookie,
          "x-csrf-token": csrf,
          origin: ORIGIN,
          "idempotency-key": key,
          "content-type": up.contentType,
        },
        payload: up.payload,
      });
    };
    expect((await send(makeDocx(FICTIONAL_RESUME_LINES), "docx-00001")).statusCode).toBe(201);
    const exe = await send(Buffer.from("MZ fake executable"), "exe-000001", "resume.pdf");
    expect(exe.statusCode).toBe(400);
    expect(exe.json<{ error: { message: string } }>().error.message).toMatch(
      /Unsupported file type/,
    );
    const big = await send(Buffer.alloc(100 * 1024, 0x25), "big-000001", "big.pdf");
    expect(big.statusCode).toBe(413);
  });

  it("saves the profile with disclosure settings and manages saved answers", async () => {
    const { call, store } = await setup();
    const put = await call("PUT", "/api/v1/profile", {
      fullName: { value: "Alex Example", disclosure: "always" },
      email: { value: "alex.example@example.com", disclosure: "ask" },
      preferences: { targetRoles: ["Software Engineer"], workModes: ["remote"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ profile: { version: number } }>().profile.version).toBe(1);
    const get = await call("GET", "/api/v1/profile");
    expect(
      get.json<{ profile: { email: { disclosure: string } } }>().profile.email.disclosure,
    ).toBe("ask");

    const saved = await call("POST", "/api/v1/saved-answers", {
      question: "Do you require sponsorship?",
      value: "No",
      sensitivity: "sensitive",
    });
    expect(saved.statusCode).toBe(201);
    const id = saved.json<{ savedAnswer: { id: string } }>().savedAnswer.id;
    expect((await call("POST", `/api/v1/saved-answers/${id}/revoke`)).statusCode).toBe(200);
    expect(
      (await call("GET", "/api/v1/saved-answers")).json<{ savedAnswers: unknown[] }>().savedAnswers,
    ).toHaveLength(0);
    // Audit events never carry the answer text.
    expect(
      JSON.stringify(store.sqlite.prepare("SELECT metadata FROM audit_events").all()),
    ).not.toContain("sponsorship");
  });
});
