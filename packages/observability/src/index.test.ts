import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, newTraceId, withTrace } from "./index.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe("logger", () => {
  it("redacts sensitive keys, secret-looking strings, and configured values", () => {
    const { lines, stream } = capture();
    const apiKey = "sk-proj-" + "z".repeat(40);
    const log = createLogger({ secretValues: ["my-session-secret-value"] }, stream);
    log.info(
      {
        headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
        password: "hunter2",
        note: "uses my-session-secret-value",
      },
      `calling provider with ${apiKey}`,
    );
    const out = lines.join("");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain(apiKey);
    expect(out).not.toContain("my-session-secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("logs request method and path without the query string", () => {
    const { lines, stream } = capture();
    createLogger({}, stream).info(
      {
        req: { method: "GET", url: "/api/v1/x?token=abc&email=a@example.com" },
        res: { statusCode: 200 },
      },
      "done",
    );
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry["req"]).toEqual({ method: "GET", path: "/api/v1/x" });
    expect(entry["res"]).toEqual({ statusCode: 200 });
    expect(lines[0]).not.toContain("abc");
  });

  it("attaches trace ids to child loggers", () => {
    const { lines, stream } = capture();
    const traceId = newTraceId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    withTrace(createLogger({}, stream), traceId, { runId: "r1" }).info("step");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ traceId, runId: "r1", msg: "step" });
  });
});
