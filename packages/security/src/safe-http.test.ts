import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PolicyError } from "@career-agent/domain";
import { safeFetch, SafeFetchError } from "./safe-http.js";

let server: Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    switch (req.url) {
      case "/json":
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        break;
      case "/big":
        res.writeHead(200, { "content-type": "application/json" }).end("x".repeat(2000));
        break;
      case "/gzip-bomb": {
        res
          .writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" })
          .end(gzipSync(Buffer.alloc(5_000_000)));
        break;
      }
      case "/redirect-ok":
        res.writeHead(302, { location: "/json" }).end();
        break;
      case "/redirect-loop":
        res.writeHead(302, { location: "/redirect-loop" }).end();
        break;
      case "/redirect-external":
        res.writeHead(302, { location: "https://evil.example.com/" }).end();
        break;
      case "/redirect-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
        break;
      case "/html":
        res.writeHead(200, { "content-type": "text/html" }).end("<p>hi</p>");
        break;
      case "/slow":
        setTimeout(() => res.writeHead(200).end("late"), 2000);
        break;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const local = () => ({ allowPrivateNetwork: true, allowHttp: true, allowedPorts: [port] });
const base = () => `http://127.0.0.1:${port}`;

describe("safeFetch", () => {
  it("fetches and follows same-policy redirects", async () => {
    const r = await safeFetch(`${base()}/redirect-ok`, { policy: local() });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('{"ok":true}');
    expect(r.finalUrl).toBe(`${base()}/json`);
  });

  it("bounds body size, including after decompression", async () => {
    await expect(safeFetch(`${base()}/big`, { policy: local(), maxBytes: 1000 })).rejects.toThrow(
      SafeFetchError,
    );
    await expect(
      safeFetch(`${base()}/gzip-bomb`, { policy: local(), maxBytes: 100_000 }),
    ).rejects.toThrow(/too large/);
  });

  it("limits redirects and re-checks every hop", async () => {
    await expect(safeFetch(`${base()}/redirect-loop`, { policy: local() })).rejects.toThrow(
      /Too many redirects/,
    );
    await expect(
      safeFetch(`${base()}/redirect-external`, {
        policy: { ...local(), allowedHosts: ["127.0.0.1"] },
      }),
    ).rejects.toThrow(PolicyError);
    // A redirect to the cloud metadata address is refused even though the first hop was allowed.
    await expect(
      safeFetch(`${base()}/redirect-metadata`, {
        policy: { ...local(), allowPrivateNetwork: false },
      }),
    ).rejects.toThrow(PolicyError);
  });

  it("enforces the expected content type", async () => {
    await expect(
      safeFetch(`${base()}/html`, { policy: local(), accept: ["application/json"] }),
    ).rejects.toThrow(/content type/);
  });

  it("times out", async () => {
    await expect(
      safeFetch(`${base()}/slow`, { policy: local(), timeoutMs: 200 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses hosts that resolve to private addresses (DNS rebinding) before connecting", async () => {
    hits.length = 0;
    const resolve = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      safeFetch(`http://jobs.example.com:${port}/json`, {
        policy: { allowHttp: true, allowedPorts: [port] },
        resolve,
      }),
    ).rejects.toThrow(/non-public/);
    expect(hits).toEqual([]);
  });

  it("connects to the address our resolver vetted", async () => {
    const resolve = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    const r = await safeFetch(`http://fixture.test:${port}/json`, { policy: local(), resolve });
    expect(r.status).toBe(200);
  });
});
