import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, ENV_KEYS, loadConfig, requireSetting } from "./index.js";

const key = randomBytes(32).toString("base64");

describe("loadConfig", () => {
  it("starts with defaults and degrades providers instead of failing", () => {
    const c = loadConfig({});
    expect(c.env.HOST).toBe("127.0.0.1");
    expect(c.env.APPROVAL_TTL_SECONDS).toBe(300);
    expect(c.env.BROWSER_HEADLESS).toBe(false);
    expect(c.env.DEFAULT_PROVIDER_MODE).toBe("hybrid");
    expect(c.databasePath).toBe("./data/career-agent.sqlite");
    expect(c.providers.openai).toEqual({
      enabled: true,
      ready: false,
      reason: "Set OPENAI_API_KEY and OPENAI_MODEL to use OpenAI.",
    });
    expect(c.warnings.join()).toMatch(/LOCAL_SESSION_SECRET/);
  });

  it("parses the documented .env.example without errors", () => {
    const text = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const env = Object.fromEntries(
      text
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(Object.keys(env).sort()).toEqual([...ENV_KEYS].sort());
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("treats empty strings as unset and parses booleans and numbers", () => {
    const c = loadConfig({
      OPENAI_API_KEY: "",
      OPENAI_MODEL: " ",
      BROWSER_HEADLESS: "true",
      API_PORT: "4001",
    });
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
    expect(c.env.BROWSER_HEADLESS).toBe(true);
    expect(c.env.API_PORT).toBe(4001);
  });

  it("marks OpenAI ready only with key and model", () => {
    expect(loadConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m" }).providers.openai).toEqual({
      enabled: true,
      ready: true,
    });
    expect(loadConfig({ OPENAI_ENABLED: "false" }).providers.openai).toEqual({ enabled: false });
  });

  it("lists every structural problem at once", () => {
    try {
      loadConfig({
        HOST: "0.0.0.0",
        API_PORT: "abc",
        DATA_ENCRYPTION_KEY: "short",
        APPROVAL_TTL_SECONDS: "99999",
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).issues.join("\n");
      expect(msg).toMatch(/HOST: HOST must be a loopback/);
      expect(msg).toMatch(/API_PORT/);
      expect(msg).toMatch(/DATA_ENCRYPTION_KEY/);
      expect(msg).toMatch(/APPROVAL_TTL_SECONDS/);
    }
  });

  it("accepts valid keys and requires settings on demand", () => {
    const c = loadConfig({
      DATA_ENCRYPTION_KEY: key,
      LOCAL_SESSION_SECRET: key,
      DATABASE_URL: ":memory:",
    });
    expect(c.databasePath).toBe(":memory:");
    expect(requireSetting(c, "LOCAL_SESSION_SECRET")).toBe(key);
    expect(() => requireSetting(loadConfig({}), "LOCAL_SESSION_SECRET")).toThrow(ConfigError);
  });

  it("never echoes secret values in errors", () => {
    try {
      loadConfig({ DATA_ENCRYPTION_KEY: "c2VjcmV0LXZhbHVl" });
    } catch (e) {
      expect((e as Error).message).not.toContain("c2VjcmV0LXZhbHVl");
    }
  });
});
