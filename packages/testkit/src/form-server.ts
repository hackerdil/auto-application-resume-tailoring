import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FormFixtureServer {
  origin: string;
  /** Every non-GET request the server received (a submission attempt reaching the "employer"). */
  writes: { method: string; path: string; at: string }[];
  /** How the "employer" answers writes: confirm (303 to a thank-you page) or drop the connection. */
  mode: "confirm" | "drop";
  close(): Promise<void>;
}

const PAGES: Record<string, string> = {
  "/greenhouse": "greenhouse.html",
  "/lever": "lever.html",
  "/ashby": "ashby.html",
  "/frame-field": "frame-field.html",
  "/login": "login.html",
  "/captcha": "captcha.html",
  "/confirmation": "confirmation.html",
};

/** Local, fictional ATS forms (fixtures/ats-forms) on 127.0.0.1. Records any write so tests can prove nothing was submitted. */
export async function startFormFixtureServer(
  opts: { port?: number } = {},
): Promise<FormFixtureServer> {
  const writes: FormFixtureServer["writes"] = [];
  const state: { mode: FormFixtureServer["mode"] } = { mode: "confirm" };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method !== "GET" && req.method !== "HEAD") {
      writes.push({ method: req.method ?? "?", path, at: new Date().toISOString() });
      req.resume();
      if (state.mode === "drop") {
        req.socket.destroy();
        return;
      }
      res.writeHead(303, { location: "/confirmation" }).end();
      return;
    }
    const file = PAGES[path];
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(readFileSync(new URL(`../../../fixtures/ats-forms/${file}`, import.meta.url)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    writes,
    get mode() {
      return state.mode;
    },
    set mode(m) {
      state.mode = m;
    },
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      ),
  };
}
