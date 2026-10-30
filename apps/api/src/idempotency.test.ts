import { describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IdempotencyRepository } from "@career-agent/domain";
import { idempotent } from "./idempotency.js";

const reply = () => {
  const r = { header: () => r, code: () => r };
  return r as unknown as FastifyReply;
};
const request = (key: string) =>
  ({
    headers: { "idempotency-key": key },
    method: "POST",
    url: "/x",
    routeOptions: { url: "/x" },
    params: {},
  }) as unknown as FastifyRequest;

describe("idempotent", () => {
  it("refuses a concurrent duplicate while the first request is still running", async () => {
    const saved: string[] = [];
    const repo: IdempotencyRepository = {
      lookup: () => null,
      save: (key) => {
        saved.push(key);
      },
    };
    let runs = 0;
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<{ statusCode: number; body: unknown }>((resolve) => {
        runs++;
        release = () => {
          resolve({ statusCode: 200, body: { ok: true } });
        };
      });
    const first = idempotent(repo, request("dup-key-123"), reply(), null, slow);
    await expect(
      idempotent(repo, request("dup-key-123"), reply(), null, slow),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    release();
    await expect(first).resolves.toEqual({ ok: true });
    expect(runs).toBe(1);
    expect(saved).toEqual(["dup-key-123"]);
  });
});
