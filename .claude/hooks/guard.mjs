#!/usr/bin/env node
// PreToolUse guard for Claude Code (ADR-013).
// Reads the hook payload on stdin; exits 2 with a reason on stderr to block.
// No network access, no writes, no dependencies.

import { pathToFileURL } from "node:url";
import path from "node:path";

const PROTECTED_PATH_PATTERNS = [
  /(^|\/)\.env(\..*)?$/, // .env, .env.local, ... (but see allowlist below)
  /(^|\/)data\//,
  /(^|\/)artifacts\//,
  /(^|\/)browser-profile(\/|$)/,
  /(^|\/)playwright\/\.auth\//,
  /\.(sqlite3?|db)(-wal|-shm)?$/,
  /(^|\/)\.claude\/settings\.local\.json$/,
];

const ALLOWED_PATHS = [/(^|\/)\.env\.example$/, /(^|\/)(data|artifacts)\/\.gitkeep$/];

const DANGEROUS_COMMANDS = [
  {
    re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*-[a-zA-Z]*[rRf][a-zA-Z]*\s+(\/|~|\$HOME|\.\.?)(\s|\/?$)/,
    why: "broad recursive delete",
  },
  {
    re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+.*(\bdata\b|\bartifacts\b|browser-profile)/,
    why: "deleting private data directories",
  },
  {
    re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx])/,
    why: "discarding working-tree changes",
  },
  { re: /\bgit\s+push\s+.*--force(?!-with-lease)/, why: "force push" },
  { re: /(^|[;&|]\s*)(env|printenv)(\s*$|\s*[;&|])/, why: "printing the environment" },
  { re: /\b(export\s+-p|set)\s*$/, why: "printing the environment" },
  // Same line only: a heredoc body that merely mentions .env on a later line is not a read.
  {
    re: /\b(cat|less|more|head|tail|bat|strings)\b[^|;&\n]*(^|[\s/'"])\.env(?!\.example)(\.[\w-]+)?(?=$|[\s'"|;&])/m,
    why: "reading secrets",
  },
  { re: /\b(security\s+(find|dump)-|dump-keychain)/, why: "keychain access" },
  { re: /\bchmod\s+-R\s+777\b/, why: "world-writable permissions" },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\//, why: "disk-level destructive command" },
];

/** @param {string} p */
function normalize(p, cwd) {
  const abs = path.isAbsolute(p) ? p : path.join(cwd || ".", p);
  return abs.split(path.sep).join("/");
}

/**
 * Decide whether a tool call should be blocked.
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} payload
 * @returns {string | null} reason to block, or null to defer to normal permissions
 */
export function evaluate(payload) {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit" || tool === "MultiEdit") {
    const raw = input.file_path ?? input.notebook_path;
    if (typeof raw !== "string") return null;
    const p = normalize(raw, payload.cwd);
    if (ALLOWED_PATHS.some((re) => re.test(p))) return null;
    if (PROTECTED_PATH_PATTERNS.some((re) => re.test(p))) {
      return `Blocked write to protected path (${raw}): secrets, private data, browser profiles and databases are off-limits to the coding agent.`;
    }
    return null;
  }

  if (tool === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    for (const { re, why } of DANGEROUS_COMMANDS) {
      if (re.test(cmd))
        return `Blocked shell command (${why}). Ask the user to run it themselves if it is really needed.`;
    }
    return null;
  }

  return null;
}

async function main() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    // Malformed payload: do not block, normal permission flow still applies.
    process.exit(0);
  }
  const reason = evaluate(payload);
  if (reason) {
    process.stderr.write(reason + "\n");
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
