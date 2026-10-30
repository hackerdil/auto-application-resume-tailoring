#!/usr/bin/env node
// `pnpm dev`: builds the workspace, then runs the TypeScript watcher, the API and worker (restart on rebuild), and Next.js.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env")) {
  console.error(
    "Missing .env. Copy .env.example to .env and set LOCAL_SESSION_SECRET and DATA_ENCRYPTION_KEY.",
  );
  process.exit(1);
}
// Children inherit the parsed .env (API ports, keys) through the environment.
process.loadEnvFile(".env");
const first = spawnSync("pnpm", ["exec", "tsc", "-b"], { stdio: "inherit" });
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
  spawn("pnpm", ["exec", "tsc", "-b", "-w", "--preserveWatchOutput"], { stdio: "inherit" }),
  spawn("node", ["--watch-path=apps/api/dist", "--watch-path=packages", "apps/api/dist/main.js"], {
    stdio: "inherit",
  }),
  spawn("pnpm", ["--filter", "@career-agent/web", "dev"], { stdio: "inherit" }),
];
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && code !== 0 && stop());
