import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAIProviders } from "@career-agent/ai";
import { loadConfig, providerSettings } from "@career-agent/config";
import { createStore } from "@career-agent/db";
import { createLogger } from "@career-agent/observability";
import { FieldCipher } from "@career-agent/security";
import { buildApp } from "./app.js";
import { documentPorts } from "./documents.js";

const API = "127.0.0.1:3001";

async function setup(env: Record<string, string>) {
  const config = loadConfig({
    DATABASE_URL: ":memory:",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    ...env,
  });
  const store = createStore({
    file: ":memory:",
    cipher: new FieldCipher("k1", { k1: randomBytes(32) }),
  });
  const ownerId = store.users.ensureOwner("Owner").id;
  const artifactDir = mkdtempSync(path.join(tmpdir(), "ca-prov-"));
  const settings = providerSettings(config);
  // Built but never called: nothing here contacts OpenAI or starts Claude.
  const ai = createAIProviders(settings);
  const app = await buildApp({
    config,
    store,
    ownerId,
    documents: documentPorts(artifactDir),
    artifactDir,
    sessionSecret: randomBytes(32),
    logger: createLogger({ level: "silent" }),
    ai: { router: ai.router, secretValues: settings.secretValues },
  });
  const s = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: API } });
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const get = (url: string) => app.inject({ method: "GET", url, headers: { host: API, cookie } });
  return { get, store, settings };
}

const run = (provider: string, taskType: string, over: Record<string, unknown> = {}) => ({
  traceId: "t",
  agentRunId: null,
  provider,
  model: "m",
  taskType,
  promptId: "p",
  promptVersion: "1",
  requestId: null,
  durationMs: 5,
  inputTokens: 100,
  cachedInputTokens: null,
  reasoningTokens: null,
  outputTokens: 10,
  costUsd: 0.002,
  toolCalls: 0,
  delegated: false,
  fallback: false,
  errorClass: null,
  ...over,
});

describe("provider status and usage API", () => {
  it("reports which providers are set up without contacting them", async () => {
    const { get, settings } = await setup({
      OPENAI_ENABLED: "true",
      OPENAI_API_KEY: "sk-test-not-real",
      CLAUDE_ENABLED: "false",
      DEFAULT_PROVIDER_MODE: "hybrid",
    });
    expect(settings.openai.ready).toBe(false); // no OPENAI_MODEL
    expect(settings.secretValues).toContain("sk-test-not-real");
    const r = await get("/api/v1/system/providers");
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      mode: string;
      providers: { provider: string; configured: boolean; reason: string }[];
    }>();
    expect(body.mode).toBe("hybrid");
    const openai = body.providers.find((p) => p.provider === "openai");
    expect(openai?.configured).toBe(false);
    expect(openai?.reason).toMatch(/OPENAI_MODEL/);
    expect(body.providers.find((p) => p.provider === "claude")).toMatchObject({
      configured: false,
    });
    expect(r.body).not.toContain("sk-test-not-real");
    expect((await get("/api/v1/system/providers")).statusCode).toBe(200);
  });

  it("summarizes recorded runs per provider and task, separating unknown costs", async () => {
    const { get, store } = await setup({ OPENAI_ENABLED: "false", CLAUDE_ENABLED: "false" });
    store.providerRuns.record(run("openai", "match_scoring"));
    store.providerRuns.record(run("openai", "match_scoring", { costUsd: null }));
    store.providerRuns.record(
      run("openai", "match_scoring", {
        errorClass: "PROVIDER_RATE_LIMIT",
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      }),
    );
    store.providerRuns.record(
      run("claude", "integrity_review", { fallback: true, delegated: true }),
    );
    const r = await get("/api/v1/system/usage?days=7");
    expect(r.json<{ rows: unknown[] }>().rows).toEqual([
      expect.objectContaining({
        provider: "claude",
        taskType: "integrity_review",
        calls: 1,
        fallbacks: 1,
        delegated: 1,
      }),
      expect.objectContaining({
        provider: "openai",
        taskType: "match_scoring",
        calls: 3,
        errors: 1,
        inputTokens: 200,
        costUsd: 0.002,
        unpricedCalls: 1,
      }),
    ]);
    expect((await get("/api/v1/system/usage?days=0")).statusCode).toBe(400);
  });

  it("parses optional OpenAI prices", () => {
    const priced = providerSettings(
      loadConfig({
        DATABASE_URL: ":memory:",
        OPENAI_INPUT_USD_PER_MTOK: "2.5",
        OPENAI_OUTPUT_USD_PER_MTOK: "10",
      }),
    );
    expect(priced.openai.pricing).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 });
    expect(
      providerSettings(loadConfig({ DATABASE_URL: ":memory:", OPENAI_INPUT_USD_PER_MTOK: "" }))
        .openai.pricing,
    ).toBeNull();
    expect(() =>
      loadConfig({ DATABASE_URL: ":memory:", OPENAI_INPUT_USD_PER_MTOK: "lots" }),
    ).toThrow();
  });
});
