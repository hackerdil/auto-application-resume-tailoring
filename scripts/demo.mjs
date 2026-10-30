#!/usr/bin/env node
// Fictional demo (`pnpm demo`): seeds a separate database with fictional people, companies, and jobs, serves
// fictional application forms on this machine, and starts the API, worker, and web app in DEMO_MODE
// (OPERATING_MODE=dry-run, no AI providers, browser limited to *.localhost). Your .env is never read.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (pkg) => pathToFileURL(path.join(ROOT, "packages", pkg, "dist", "index.js")).href;

export const DEMO_PORTS = { web: 3000, api: 3001, ats: 3102 };

/** Demo-only keys, generated once and kept beside the demo database (they protect fictional data only). */
function demoKeys(dir) {
  const file = path.join(dir, "demo-keys.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const keys = {
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    LOCAL_SESSION_SECRET: randomBytes(32).toString("base64"),
  };
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  return keys;
}

/** The complete environment for demo processes: built from scratch, never inherited secrets. */
export function demoEnv({ dataDir, ports = DEMO_PORTS, headless = false }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const base = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"])
    if (process.env[k]) base[k] = process.env[k];
  return {
    ...base,
    ...demoKeys(dataDir),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    WEB_PORT: String(ports.web),
    API_PORT: String(ports.api),
    DATABASE_URL: `file:${path.join(dataDir, "career-agent.sqlite")}`,
    DATA_DIR: dataDir,
    ARTIFACT_DIR: path.join(dataDir, "artifacts"),
    BROWSER_PROFILE_DIR: path.join(dataDir, "browser-profile"),
    CLAUDE_WORKING_DIRECTORY: path.join(dataDir, "claude-workspace"),
    DEMO_MODE: "true",
    OPERATING_MODE: "dry-run",
    OPENAI_ENABLED: "false",
    CLAUDE_ENABLED: "false",
    BROWSER_HEADLESS: headless ? "true" : "false",
    LOG_LEVEL: "warn",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

const FACTS = [
  ["role", "Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025"],
  ["achievement", "Built a TypeScript billing service used by 40 internal teams"],
  ["achievement", "Reduced CI time from 30 to 12 minutes"],
  ["achievement", "Migrated 14 services from MySQL to PostgreSQL without downtime"],
  ["role", "Software Engineer, Globex Example Inc, 2018 - 2021"],
  ["achievement", "Designed REST APIs for a fictional logistics product"],
  ["skill", "TypeScript"],
  ["skill", "PostgreSQL"],
  ["skill", "Node.js"],
  ["education", "BSc Computer Science, Example University, 2018"],
];

const JOBS = (ats) =>
  [
    {
      key: "demo/1",
      title: "Senior Backend Engineer",
      company: "Acme Fictional Ltd",
      form: "greenhouse",
      text: "Build our fictional billing platform.\n\nWhat you'll need\n- 5+ years of TypeScript\n- PostgreSQL experience\n\nNice to have\n- Experience with CI pipelines",
      req: ["5+ years of TypeScript", "PostgreSQL experience"],
      pref: ["Experience with CI pipelines"],
    },
    {
      key: "demo/2",
      title: "Staff Platform Engineer",
      company: "Globex Example Inc",
      form: "lever",
      text: "Lead our fictional platform team.\n\nRequirements\n- Node.js services in production\n- Mentoring engineers",
      req: ["Node.js services in production", "Mentoring engineers"],
      pref: [],
    },
    {
      key: "demo/3",
      title: "Product Designer",
      company: "Initech Example",
      form: "ashby",
      text: "Design fictional products.\n\nRequirements\n- A portfolio of product design work\n- Figma",
      req: ["A portfolio of product design work", "Figma"],
      pref: [],
    },
  ].map((j) => ({ ...j, url: `${ats}/${j.form}` }));

/** Idempotent: re-running refreshes the form URLs (the port may change) and adds nothing twice. */
export async function seedDemo(env) {
  const [{ createStore }, domain, { FieldCipher, parseDataKey, sha256Hex }] = await Promise.all([
    import(dist("db")),
    import(dist("domain")),
    import(dist("security")),
  ]);
  const store = createStore({
    file: env.DATABASE_URL.slice("file:".length),
    cipher: new FieldCipher("k1", { k1: parseDataKey(env.DATA_ENCRYPTION_KEY) }),
  });
  const owner = store.users.ensureOwner("Alex Example");
  const now = new Date().toISOString();
  if (store.facts.listActive(owner.id).length === 0) {
    store.profiles.save(owner.id, {
      fullName: { value: "Alex Example", disclosure: "always" },
      email: { value: "alex.example@example.com", disclosure: "always" },
      phone: { value: "+1 555 0142", disclosure: "always" },
      location: { value: "Berlin", disclosure: "always" },
      links: [{ label: "LinkedIn", url: "https://www.linkedin.example.com/in/alex-example" }],
      preferences: {},
    });
    for (const [category, claim] of FACTS)
      store.facts.add(owner.id, {
        category,
        claim,
        source: "user-confirmed",
        verifiedAt: now,
        allowedTransformations: ["select", "reorder", "shorten", "rephrase", "combine"],
        sensitive: false,
      });
  }
  const ats = `http://ats.localhost:${env.ATS_PORT}`;
  for (const j of JOBS(ats)) {
    const id = domain.canonicalJobId("greenhouse", j.key);
    const res = store.jobs.upsert({
      id,
      source: "greenhouse",
      externalId: j.key,
      sourceUrl: j.url,
      applyUrl: j.url,
      company: j.company,
      title: j.title,
      team: null,
      locations: ["Remote"],
      workMode: "remote",
      employmentType: "full_time",
      seniority: "unknown",
      descriptionText: j.text,
      descriptionHtmlSanitized: null,
      requiredQualifications: j.req,
      preferredQualifications: j.pref,
      compensation: null,
      sponsorship: { value: "unknown", confidence: 0, evidence: null },
      postedAt: now,
      updatedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      sourceHash: sha256Hex(j.key),
      contentHash: sha256Hex(j.text),
      status: "ELIGIBLE",
      filterReasons: [],
      removedFromSourceAt: null,
    });
    if (res.outcome === "created")
      store.tasks.enqueue(
        domain.SCORE_JOB_TASK,
        { jobId: id, traceId: "demo-seed" },
        `${domain.scoreKeyPrefix(id)}demo`,
      );
  }
  store.close();
}

async function waitFor(url, timeoutMs, child) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${url}: process exited (${child.exitCode})`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Starts the whole demo; returns its URL and a stop function. Requires `pnpm build` first. */
export async function startDemo({
  dataDir = path.join(ROOT, "data", "demo"),
  headless = false,
  ports = DEMO_PORTS,
  quiet = false,
} = {}) {
  for (const f of ["apps/api/dist/main.js", "apps/worker/dist/main.js", "apps/web/.next/BUILD_ID"])
    if (!existsSync(path.join(ROOT, f))) throw new Error(`Missing ${f}: run \`pnpm build\` first.`);
  const env = { ...demoEnv({ dataDir, ports, headless }), ATS_PORT: String(ports.ats) };
  const { startFormFixtureServer } = await import(dist("testkit"));
  const ats = await startFormFixtureServer({ port: ports.ats });
  await seedDemo(env);
  const stdio = quiet ? "ignore" : "inherit";
  const children = [
    spawn(process.execPath, ["dist/main.js"], { cwd: path.join(ROOT, "apps/api"), env, stdio }),
    spawn(process.execPath, ["dist/main.js"], { cwd: path.join(ROOT, "apps/worker"), env, stdio }),
    spawn(
      process.execPath,
      [
        path.join(ROOT, "apps/web/node_modules/next/dist/bin/next"),
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        String(ports.web),
      ],
      {
        cwd: path.join(ROOT, "apps/web"),
        env,
        stdio,
      },
    ),
  ];
  const stop = async () => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    await Promise.all(
      children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r)))),
    );
    await ats.close();
  };
  try {
    await waitFor(`http://127.0.0.1:${ports.api}/api/v1/health`, 30_000, children[0]);
    await waitFor(`http://127.0.0.1:${ports.web}/`, 60_000, children[2]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: `http://127.0.0.1:${ports.web}`, ats, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const demo = await startDemo();
  console.log(
    `\nCareer Agent demo running at ${demo.url}\nEverything here is fictional. Press Ctrl+C to stop.\n`,
  );
  const shutdown = () => {
    void demo.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
