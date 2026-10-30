---
paths:
  - "packages/ai/**"
  - "apps/worker/src/**/provider*"
---

# AI provider rules

- Use only official SDKs (`@openai/agents`, `openai`, `@anthropic-ai/claude-agent-sdk`). Verify option/method names against the installed `.d.ts` before use; never invent APIs.
- Model ids come from config (`OPENAI_MODEL`, `CLAUDE_MODEL`); never hardcode aliases.
- Every call takes `RunLimits`: deadline, `AbortSignal`, max turns, max tool calls, max input/output size, cost budget, trace ID, idempotency key.
- Structured output validated by Zod; one repair attempt, then `ProviderInvalidOutputError`.
- Map raw SDK errors to the provider error classes; never surface raw messages, headers, paths, or stacks.
- Track `attemptedProviders`; no fallback cycles. Retry only rate-limit/timeout/unavailable, capped with jitter.
- Claude Agent SDK: `tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, dedicated empty `cwd`, explicit minimal `env` without other secrets, bounded `maxTurns`/`maxBudgetUsd`. Never `bypassPermissions` (ADR-008).
- Never scrape claude.ai/ChatGPT web sessions or copy cookies.
- Untrusted text goes in the `<untrusted_content>` envelope (docs/PROMPT_SECURITY.md). Prompts live versioned in `packages/ai/src/prompts/`.
- Tests use `packages/testkit` fake providers. Live calls only behind `ENABLE_LIVE_AI_TESTS=true` with explicit owner authorization.
- Never import `@career-agent/browser/submission` (ADR-007).
