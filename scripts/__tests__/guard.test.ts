import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM hook script without type declarations
import { evaluate } from "../../.claude/hooks/guard.mjs";

const run = (tool_name: string, tool_input: Record<string, unknown>) =>
  (evaluate as (p: unknown) => string | null)({ tool_name, tool_input, cwd: "/repo" });

describe("PreToolUse guard", () => {
  it.each([
    ".env",
    ".env.local",
    "data/career-agent.sqlite",
    "artifacts/abc.pdf",
    "data/browser-profile/Default/Cookies",
    "x/db.sqlite-wal",
    ".claude/settings.local.json",
  ])("blocks writes to %s", (p) => {
    expect(run("Write", { file_path: p })).toMatch(/Blocked write/);
    expect(run("Edit", { file_path: `/repo/${p}` })).toMatch(/Blocked write/);
  });

  it.each([".env.example", "data/.gitkeep", "packages/domain/src/index.ts", "docs/DATA_MODEL.md"])(
    "allows writes to %s",
    (p) => {
      expect(run("Write", { file_path: p })).toBeNull();
    },
  );

  it.each([
    "rm -rf /",
    "rm -rf ~",
    "rm -rf .",
    "rm -rf data",
    "git reset --hard",
    "git clean -fdx",
    "git push origin main --force",
    "env",
    "printenv",
    "pnpm test && env",
    "cat .env",
    "cat .env.local",
    "head -5 ./.env",
    "less '/repo/.env'",
    "pnpm build && cat .env",
    "security find-generic-password -s x",
  ])("blocks %s", (command) => {
    expect(run("Bash", { command })).toMatch(/Blocked shell command/);
  });

  it.each([
    "pnpm check",
    "rm -rf dist",
    "rm -rf packages/domain/dist",
    "git status",
    "git push --force-with-lease",
    "cat .env.example",
    "cat > docs/OPERATIONS.md <<'EOF'\n1. cp .env.example .env\nEOF",
    "cat README.md",
    "NODE_ENV=test pnpm test",
    "rg environment packages",
  ])("allows %s", (command) => {
    expect(run("Bash", { command })).toBeNull();
  });

  it("ignores other tools", () => {
    expect(run("Read", { file_path: ".env" })).toBeNull();
  });
});
