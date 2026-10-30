import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@career-agent/observability";
import { startFormFixtureServer, type FormFixtureServer } from "@career-agent/testkit";
import { setup } from "./browser-test-setup.js";
import { BrowserPreparer } from "./preparer.js";

let server: FormFixtureServer;
beforeAll(async () => {
  server = await startFormFixtureServer();
});
afterAll(async () => {
  await server.close();
});

describe("browser preparation (worker)", () => {
  it("fills the fixture form, waits for the owner, then reaches review without any write", async () => {
    const s = setup(null, `${server.origin.replace("127.0.0.1", "ats.localhost")}/greenhouse`);
    const app = s.service.create(s.ownerId, s.job.id, "t");
    const resume = await s.tailoring.tailor(s.job.id, s.ownerId, "one-page", "t");
    s.tailoring.decide(resume.resume.id, "approved", "t");
    s.service.selectResume(s.ownerId, app.id, resume.resume.id, "t");
    s.service.skipCoverLetter(s.ownerId, app.id, true, "t");
    const preparer = new BrowserPreparer({
      store: s.store,
      applications: s.service,
      files: s.files,
      ownerId: s.ownerId,
      logger: createLogger({ level: "silent" }),
      headless: true,
      maxSteps: 60,
      sessionTimeoutMs: 60_000,
      allowPrivateNetwork: true,
    });
    try {
      const first = await preparer.prepare(app.id, "t");
      expect(first.status).toBe("awaiting_input");
      let o = s.service.overview(s.ownerId, app.id);
      expect(o.application.state).toBe("AWAITING_USER_INPUT");
      expect(s.store.browserSessions.latest(app.id)).toMatchObject({
        status: "awaiting_input",
        adapter: "greenhouse",
      });
      for (const [category, value] of [
        ["work_authorization", "Yes"],
        ["sponsorship", "No"],
      ] as const) {
        const a = o.answers.find((x) => x.field.category === category && x.field.origin === "page");
        if (!a) throw new Error(`expected ${category}`);
        o = s.service.answer(s.ownerId, app.id, a.field.id, { value }, "t");
      }
      const second = await preparer.prepare(app.id, "t");
      expect(second.status).toBe("ready");
      expect(s.service.overview(s.ownerId, app.id).application.state).toBe("READY_FOR_REVIEW");
      expect(s.store.browserSessions.latest(app.id)).toMatchObject({ status: "ready" });
      expect(server.writes).toEqual([]);
      const audit = JSON.stringify(
        s.store.sqlite
          .prepare("SELECT metadata FROM audit_events WHERE type = 'browser.prepared'")
          .all(),
      );
      expect(audit).toContain("greenhouse");
      expect(audit).not.toMatch(/Alex|alex\.example/);
    } finally {
      await preparer.closeAll();
    }
    expect(s.store.browserSessions.latest(app.id)?.status).toBe("closed");
  });
});
