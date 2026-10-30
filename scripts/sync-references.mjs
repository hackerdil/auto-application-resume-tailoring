#!/usr/bin/env node
// Keeps each workspace tsconfig's project references in sync with its @career-agent/* dependencies.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dirs = ["packages", "apps"].flatMap((g) =>
  readdirSync(path.join(root, g)).map((d) => path.join(g, d)),
);
const byName = new Map();
for (const d of dirs) {
  const pkg = JSON.parse(readFileSync(path.join(root, d, "package.json"), "utf8"));
  byName.set(pkg.name, d);
}
for (const d of dirs) {
  const tsconfigPath = path.join(root, d, "tsconfig.json");
  if (!existsSync(tsconfigPath)) continue;
  const pkg = JSON.parse(readFileSync(path.join(root, d, "package.json"), "utf8"));
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  if (tsconfig.compilerOptions?.composite === false) continue; // e.g. the Next.js app
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) =>
    byName.has(n),
  );
  const refs = deps.map((n) => ({
    path: path.relative(path.join(root, d), path.join(root, byName.get(n))),
  }));
  if (refs.length) tsconfig.references = refs;
  else delete tsconfig.references;
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
}
