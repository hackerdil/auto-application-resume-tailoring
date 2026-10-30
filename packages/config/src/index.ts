import { z } from "zod";

/** Treat empty strings from .env files as "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? String(def) : v))
    .pipe(z.coerce.number<string>().int().min(min).max(max));

const money = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? String(def) : v))
    .pipe(z.coerce.number<string>().min(0).max(100));

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const base64Key = (name: string, minBytes: number) =>
  optionalString.refine(
    (v) =>
      v === undefined || Buffer.from(v, /[-_]/.test(v) ? "base64url" : "base64").length >= minBytes,
    { message: `${name} must be at least ${minBytes} random bytes, base64-encoded` },
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z
    .string()
    .default("127.0.0.1")
    .refine((h) => LOOPBACK.has(h), {
      message:
        "HOST must be a loopback address (127.0.0.1 or ::1). Remote mode is not supported in the MVP.",
    }),
  WEB_PORT: int(3000, 1024, 65535),
  API_PORT: int(3001, 1024, 65535),
  LOCAL_SESSION_SECRET: base64Key("LOCAL_SESSION_SECRET", 32),
  DATA_ENCRYPTION_KEY: base64Key("DATA_ENCRYPTION_KEY", 32).refine(
    (v) => v === undefined || Buffer.from(v, /[-_]/.test(v) ? "base64url" : "base64").length === 32,
    { message: "DATA_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded" },
  ),
  DATABASE_URL: z
    .string()
    .default("file:./data/career-agent.sqlite")
    .refine((v) => v.startsWith("file:") || v === ":memory:", {
      message: 'DATABASE_URL must be "file:<path>" or ":memory:"',
    }),
  DATA_DIR: z.string().default("./data"),
  ARTIFACT_DIR: z.string().default("./artifacts"),
  BROWSER_PROFILE_DIR: z.string().default("./data/browser-profile"),

  OPENAI_ENABLED: bool(true),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  OPENAI_MAX_TURNS: int(8, 1, 50),
  OPENAI_MAX_COST_USD_PER_RUN: money(1),

  CLAUDE_ENABLED: bool(true),
  CLAUDE_MODE: z.enum(["subscription"]).default("subscription"),
  CLAUDE_MODEL: optionalString,
  CLAUDE_WORKING_DIRECTORY: z.string().default("./data/claude-workspace"),
  CLAUDE_MAX_TURNS: int(6, 1, 50),
  CLAUDE_MAX_COST_USD_PER_RUN: money(1),

  DEFAULT_PROVIDER_MODE: z
    .enum(["openai", "claude", "hybrid", "compare", "auto"])
    .default("hybrid"),
  PROVIDER_TIMEOUT_MS: int(120_000, 1_000, 900_000),
  MAX_PROVIDER_RETRIES: int(2, 0, 5),
  MAX_CLAUDE_DELEGATIONS_PER_RUN: int(2, 0, 10),

  DISCOVERY_SCHEDULE_ENABLED: bool(false),
  DISCOVERY_CRON: optionalString,
  ENABLE_WORKABLE: bool(false),
  JOB_FRESHNESS_DAYS: int(30, 1, 365),
  MATCH_SCORE_THRESHOLD: int(70, 0, 100),
  MAX_JOBS_SCORED_PER_RUN: int(50, 1, 1000),

  BROWSER_HEADLESS: bool(false),
  BROWSER_MAX_STEPS: int(40, 1, 500),
  BROWSER_TIMEOUT_MS: int(600_000, 10_000, 3_600_000),
  APPROVAL_TTL_SECONDS: int(300, 30, 900),
  /** research-only · prepare · review-each (one approval per application) · dry-run. Submission needs review-each. */
  OPERATING_MODE: z
    .enum(["research-only", "prepare", "review-each", "dry-run"])
    .default("review-each"),
  SCREENSHOT_RETENTION_DAYS: int(7, 0, 365),
  STORE_REDACTED_SCREENSHOTS: bool(false),

  STORE_FULL_PROMPTS: bool(false),
  STORE_FULL_MODEL_OUTPUTS: bool(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ENABLE_LIVE_AI_TESTS: bool(false),
  ENABLE_LIVE_SOURCE_TESTS: bool(false),
});

export type Env = z.infer<typeof EnvSchema>;

export type ProviderStatus =
  | { enabled: false }
  | { enabled: true; ready: true }
  | { enabled: true; ready: false; reason: string };

export interface AppConfig {
  env: Env;
  databasePath: string;
  providers: { openai: ProviderStatus; claude: ProviderStatus };
  /** Problems that disable features without preventing startup. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\nSee .env.example for documentation.`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Validates the environment. Structural problems throw ConfigError with every issue listed.
 * Missing provider credentials only mark that provider unavailable, so local/read-only features still start.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const env = parsed.data;
  const warnings: string[] = [];

  let openai: ProviderStatus = { enabled: false };
  if (env.OPENAI_ENABLED) {
    const missing = [
      !env.OPENAI_API_KEY && "OPENAI_API_KEY",
      !env.OPENAI_MODEL && "OPENAI_MODEL",
    ].filter(Boolean);
    openai = missing.length
      ? { enabled: true, ready: false, reason: `Set ${missing.join(" and ")} to use OpenAI.` }
      : { enabled: true, ready: true };
    if (!openai.ready) warnings.push(`OpenAI unavailable: ${openai.reason}`);
  }

  // Claude subscription mode authenticates through the local Claude Code login, checked at runtime by health().
  const claude: ProviderStatus = env.CLAUDE_ENABLED
    ? { enabled: true, ready: true }
    : { enabled: false };

  if (!env.LOCAL_SESSION_SECRET)
    warnings.push("LOCAL_SESSION_SECRET is not set; the API and approvals are disabled.");
  if (!env.DATA_ENCRYPTION_KEY)
    warnings.push(
      "DATA_ENCRYPTION_KEY is not set; storing sensitive fields is disabled unless an OS keychain key is configured.",
    );

  const databasePath =
    env.DATABASE_URL === ":memory:" ? ":memory:" : env.DATABASE_URL.slice("file:".length);
  return { env, databasePath, providers: { openai, claude }, warnings };
}

/** For components that cannot run without a value (e.g. the API needs the session secret). */
export function requireSetting<K extends keyof Env>(
  config: AppConfig,
  key: K,
): NonNullable<Env[K]> {
  const v: Env[K] | undefined = config.env[key];
  if (v === undefined) throw new ConfigError([`${key} is required for this command.`]);
  return v;
}

export const ENV_KEYS: readonly string[] = Object.keys(EnvSchema.shape);
