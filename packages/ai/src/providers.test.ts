import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import {
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PolicyError,
  ProviderAuthenticationError,
  ProviderPolicyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type ProviderName,
  type RunLimits,
} from "@career-agent/domain";
import { orchestrate } from "./orchestrator.js";
import { ClaudeAgentProvider, lockedDownOptions, minimalEnv } from "./providers/claude.js";
import { mapOpenAIError, OpenAIAgentsProvider } from "./providers/openai.js";
import { ProviderRouter } from "./providers/router.js";
import type { AIProvider, ProviderHealth, ProviderRequest, ProviderResult } from "./types.js";

/** Local scripted provider (testkit depends on this package, so it cannot be imported here). */
class FakeProvider implements AIProvider {
  readonly requests: ProviderRequest[] = [];
  constructor(
    private readonly script: unknown[],
    readonly name: ProviderName,
  ) {}
  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true });
  }
  run(req: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined)
      return Promise.reject(new ProviderUnavailableError(this.name, "script exhausted"));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      output: next,
      meta: {
        provider: this.name,
        model: "fake",
        traceId: req.traceId,
        requestId: null,
        durationMs: 1,
        usage: { inputTokens: 1, cachedInputTokens: null, reasoningTokens: null, outputTokens: 1 },
        costUsd: null,
        toolCalls: 0,
        delegated: false,
        fallback: false,
      },
    });
  }
}

const LIMITS: RunLimits = {
  deadlineMs: 30_000,
  maxModelTurns: 6,
  maxToolCalls: 10,
  maxBrowserSteps: 10,
  maxRetries: 2,
  maxInputChars: 50_000,
  maxOutputTokens: 2_000,
  maxCostUsd: 1,
};

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  taskType: "match_scoring",
  promptId: "test",
  promptVersion: "1",
  messages: [
    { role: "system", content: "Be helpful." },
    { role: "user", content: "Say ok." },
  ],
  outputJsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  limits: LIMITS,
  signal: new AbortController().signal,
  traceId: "trace-1",
  ...over,
});

/** Scripted stand-in for an OpenAI model behind the Agents SDK's own Model interface (no network). */
class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly steps: ((req: ModelRequest) => ModelResponse["output"])[]) {}
  getResponse(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const step = this.steps.shift();
    if (!step) throw new Error("script exhausted");
    return Promise.resolve({
      usage: new Usage({ requests: 1, inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 }),
      output: step(req),
      responseId: `resp-${this.requests.length}`,
    });
  }
  getStreamedResponse(): AsyncIterable<never> {
    throw new Error("not used");
  }
}

const provider = (model: Model): ModelProvider => ({ getModel: () => model });
const message = (text: string): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  },
];
const call = (name: string, args: unknown, id: string): ModelResponse["output"] => [
  { type: "function_call", callId: id, name, arguments: JSON.stringify(args), status: "completed" },
];

describe("OpenAIAgentsProvider", () => {
  it("returns parsed structured output with usage and configured pricing", async () => {
    const model = new ScriptedModel([() => message('{"ok":true}')]);
    const p = new OpenAIAgentsProvider(
      {
        apiKey: "test",
        model: "configured-model",
        maxTurns: 4,
        timeoutMs: 10_000,
        pricing: { inputPerMTok: 2, outputPerMTok: 8 },
      },
      { modelProvider: provider(model) },
    );
    const r = await p.run(request());
    expect(r.output).toEqual({ ok: true });
    expect(r.meta).toMatchObject({
      provider: "openai",
      model: "configured-model",
      requestId: "resp-1",
    });
    expect(r.meta.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 200 });
    expect(r.meta.costUsd).toBeCloseTo((1_000 * 2 + 200 * 8) / 1_000_000);
    // System messages become the agent's instructions; no tools unless a caller passes them.
    expect(model.requests[0]?.systemInstructions).toBe("Be helpful.");
    expect(model.requests[0]?.tools).toEqual([]);
  });

  it("maps SDK and HTTP errors without leaking their text", () => {
    expect(mapOpenAIError({ status: 401, message: "sk-secret-in-message" })).toBeInstanceOf(
      ProviderAuthenticationError,
    );
    expect(mapOpenAIError({ status: 429 })).toBeInstanceOf(ProviderRateLimitError);
    expect(mapOpenAIError({ status: 429, code: "insufficient_quota" }).code).toBe(
      "PROVIDER_QUOTA_EXCEEDED",
    );
    expect(mapOpenAIError({ status: 503 })).toBeInstanceOf(ProviderUnavailableError);
    expect(mapOpenAIError({ status: 401, message: "sk-secret-in-message" }).message).not.toContain(
      "sk-",
    );
  });
});

describe("ClaudeAgentProvider (ADR-008)", () => {
  const cfg = {
    workingDirectory: mkdtempSync(path.join(tmpdir(), "ca-claude-")),
    model: null,
    maxTurns: 3,
    maxBudgetUsd: 0.5,
    timeoutMs: 10_000,
  };

  it("locks the SDK down: no tools, no settings, no persistence, no secrets in env", () => {
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test",
      DATA_ENCRYPTION_KEY: "k",
      LOCAL_SESSION_SECRET: "s",
    };
    const o = lockedDownOptions(cfg, request(), new AbortController(), "sys");
    expect(o).toMatchObject({
      tools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      mcpServers: {},
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      cwd: cfg.workingDirectory,
      outputFormat: { type: "json_schema" },
    });
    expect(o.permissionMode).not.toBe("bypassPermissions");
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch"]),
    );
    const e = minimalEnv(env);
    expect(Object.keys(e)).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY"]));
    expect(JSON.stringify(e)).not.toMatch(/sk-test|LOCAL_SESSION_SECRET|DATA_ENCRYPTION_KEY/);
  });

  const fakeQuery = (messages: unknown[]) =>
    (() =>
      (async function* () {
        await Promise.resolve();
        for (const m of messages) yield m;
      })()) as unknown as typeof query;

  const result = (over: Record<string, unknown>) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.01,
    session_id: "s1",
    modelUsage: {
      "claude-x": {
        inputTokens: 300,
        outputTokens: 40,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow: 1,
        maxOutputTokens: 1,
      },
    },
    ...over,
  });

  it("returns the SDK's structured output with usage and its cost estimate", async () => {
    const p = new ClaudeAgentProvider(
      cfg,
      fakeQuery([result({ structured_output: { ok: true } })]),
    );
    const r = await p.run(request({ taskType: "integrity_review" }));
    expect(r.output).toEqual({ ok: true });
    expect(r.meta).toMatchObject({ provider: "claude", model: "claude-x", costUsd: 0.01 });
    expect(r.meta.usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 40,
      cachedInputTokens: 5,
    });
  });

  it("maps sign-in, limits, and turn errors", async () => {
    await expect(
      new ClaudeAgentProvider(
        cfg,
        fakeQuery([
          { type: "auth_status", isAuthenticating: false, output: [], error: "no login" },
          result({ structured_output: {} }),
        ]),
      ).run(request()),
    ).rejects.toBeInstanceOf(ProviderAuthenticationError);
    await expect(
      new ClaudeAgentProvider(
        cfg,
        fakeQuery([result({ is_error: true, api_error_status: 429 })]),
      ).run(request()),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(
      new ClaudeAgentProvider(
        cfg,
        fakeQuery([result({ subtype: "error_max_turns", is_error: true })]),
      ).run(request()),
    ).rejects.toMatchObject({ code: "PROVIDER_EXECUTION" });
  });
});

describe("ProviderRouter", () => {
  const ok = { ok: true };
  const opts = (over = {}) => ({
    mode: "hybrid" as const,
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...over,
  });

  it("retries rate limits with backoff, then succeeds", async () => {
    const openai = new FakeProvider(
      [new ProviderRateLimitError("openai", "slow down"), ok],
      "openai",
    );
    const r = await new ProviderRouter({ openai }, opts()).run(request());
    expect(r.output).toEqual(ok);
    expect(r.meta.fallback).toBe(false);
    expect(openai.requests).toHaveLength(2);
  });

  it("falls back once on a non-retryable provider error and records failures", async () => {
    const failures: string[] = [];
    const openai = new FakeProvider(
      [new ProviderAuthenticationError("openai", "bad key")],
      "openai",
    );
    const claude = new FakeProvider([ok], "claude");
    const router = new ProviderRouter(
      { openai, claude },
      opts({ onFailure: (p: string, e: { code: string }) => failures.push(`${p}:${e.code}`) }),
    );
    const r = await router.run(request());
    expect(r.meta.fallback).toBe(true);
    expect(r.meta.provider).toBe("claude");
    expect(openai.requests).toHaveLength(1);
    expect(failures).toEqual(["openai:PROVIDER_AUTHENTICATION"]);
  });

  it("never falls back in explicit single-provider modes, nor for refusals", async () => {
    const claude = new FakeProvider([ok], "claude");
    await expect(
      new ProviderRouter(
        {
          openai: new FakeProvider([new ProviderAuthenticationError("openai", "x")], "openai"),
          claude,
        },
        opts({ mode: "openai" }),
      ).run(request()),
    ).rejects.toBeInstanceOf(ProviderAuthenticationError);
    await expect(
      new ProviderRouter(
        {
          openai: new FakeProvider([new ProviderPolicyError("openai", "refused")], "openai"),
          claude,
        },
        opts(),
      ).run(request()),
    ).rejects.toBeInstanceOf(ProviderPolicyError);
    expect(claude.requests).toHaveLength(0);
  });

  it("sends review tasks to Claude first in hybrid mode and tries each provider at most once", async () => {
    const router = new ProviderRouter(
      {
        openai: new FakeProvider(
          [
            new ProviderUnavailableError("openai", "down"),
            new ProviderUnavailableError("openai", "down"),
            new ProviderUnavailableError("openai", "down"),
          ],
          "openai",
        ),
        claude: new FakeProvider([new ProviderAuthenticationError("claude", "login")], "claude"),
      },
      opts(),
    );
    expect(router.order("integrity_review")).toEqual(["claude", "openai"]);
    expect(router.order("resume_tailoring")).toEqual(["openai", "claude"]);
    await expect(router.run(request({ taskType: "integrity_review" }))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("pauses a provider after repeated failures and reports it", async () => {
    let now = 1_000_000;
    const openai = new FakeProvider(
      Array.from({ length: 3 }, () => new ProviderAuthenticationError("openai", "bad key")),
      "openai",
    );
    const router = new ProviderRouter({ openai }, opts({ mode: "auto", now: () => now }));
    for (let i = 0; i < 3; i++) await router.run(request()).catch(() => undefined);
    const report = await router.healthReport();
    expect(report.find((r) => r.provider === "openai")).toMatchObject({
      ok: false,
      consecutiveFailures: 3,
      lastErrorCode: "PROVIDER_AUTHENTICATION",
    });
    expect(report.find((r) => r.provider === "claude")).toMatchObject({ configured: false });
    now += 61_000;
    expect((await router.healthReport()).find((r) => r.provider === "openai")?.ok).toBe(true);
  });

  it("refuses to run with no provider", async () => {
    await expect(new ProviderRouter({}, opts()).run(request())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("orchestrate (OpenAI + delegate_to_claude)", () => {
  it("runs only the given tools, caps delegations, and validates the final output", async () => {
    const calls: unknown[] = [];
    const model = new ScriptedModel([
      () => call("inspect_page", {}, "c1"),
      () => [
        ...call("delegate_to_claude", { question: "Is this consent?", context: "label" }, "c2"),
        ...call("delegate_to_claude", { question: "again" }, "c3"),
      ],
      (req) => {
        // Tool results come back to the model; the second delegation was refused by the cap.
        const text = JSON.stringify(req.input);
        expect(text).toContain("delegation limit");
        return message('{"status":"needs_owner","notes":["consent box"]}');
      },
    ]);
    const openai = new OpenAIAgentsProvider(
      { apiKey: "test", model: "m", maxTurns: 6, timeoutMs: 10_000 },
      { modelProvider: provider(model) },
    );
    const claude = new FakeProvider(
      [{ answer: "Looks like consent.", concerns: ["consent"] }],
      "claude",
    );
    const runs: string[] = [];
    const out = await orchestrate({
      openai,
      claude,
      maxDelegations: 1,
      tools: [
        {
          name: "inspect_page",
          description: "Inspect.",
          input: z.object({}),
          call: (i) => {
            calls.push(i);
            return Promise.resolve({ url: "https://example.com" });
          },
        },
      ],
      taskType: "form_preparation",
      prompt: { id: "form-preparation", version: "1" },
      messages: [
        { role: "system", content: "Prepare." },
        { role: "user", content: "Go." },
      ],
      schema: z.object({
        status: z.enum(["ready_for_review", "needs_owner"]),
        notes: z.array(z.string()),
      }),
      limits: LIMITS,
      signal: new AbortController().signal,
      traceId: "t",
      onRun: (r) => runs.push(`${r.provider}:${r.delegated ? "delegated" : "main"}`),
    });
    expect(out.value).toEqual({ status: "needs_owner", notes: ["consent box"] });
    expect(out.delegations).toBe(1);
    expect(calls).toHaveLength(1);
    expect(claude.requests).toHaveLength(1);
    expect(runs).toEqual(["claude:delegated", "openai:main"]);
    // Only the passed tools plus delegate_to_claude are offered: nothing that could submit or run script.
    expect(model.requests[0]?.tools.map((t) => t.name).sort()).toEqual([
      "delegate_to_claude",
      "inspect_page",
    ]);
  });
});

describe("budget and failure accounting (security review M2/L3)", () => {
  it("passes each call only the remaining cost and records a failed orchestrator run", async () => {
    let seen = "";
    const model = new ScriptedModel([
      () => call("explode", {}, "c1"),
      (req) => {
        seen = JSON.stringify(req.input);
        throw new Error("model down");
      },
    ]);
    const openai = new OpenAIAgentsProvider(
      { apiKey: "test", model: "m", maxTurns: 6, timeoutMs: 10_000 },
      { modelProvider: provider(model) },
    );
    const rows: { errorClass: string | null }[] = [];
    await expect(
      orchestrate({
        openai,
        claude: null,
        maxDelegations: 0,
        tools: [
          {
            name: "explode",
            description: "Fails.",
            input: z.object({}),
            call: () => Promise.reject(new PolicyError("ENOENT /Users/secret/path")),
          },
        ],
        taskType: "form_preparation",
        prompt: { id: "form-preparation", version: "1" },
        messages: [{ role: "user", content: "Go." }],
        schema: z.object({ ok: z.boolean() }),
        limits: LIMITS,
        signal: new AbortController().signal,
        traceId: "t",
        onRun: (r) => rows.push(r),
      }),
    ).rejects.toBeTruthy();
    // The tool's raw error text never reaches the model, only a fixed message for its class.
    expect(seen).toContain("Refused by Career Agent");
    expect(seen).not.toContain("/Users/secret/path");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.errorClass).toBeTruthy();
  });
});
