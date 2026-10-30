import { describe, expect, it } from "vitest";
import { fixtureJob, testStore } from "./test-helpers.js";

describe("browser sessions", () => {
  it("records status, strips URL queries, and ends sessions for good", () => {
    const { store, ownerId, job } = setup();
    const app = store.applications.create(ownerId, job, "t");
    const s = store.browserSessions.start(app.id, {
      adapter: "greenhouse",
      originAllowlist: ["https://boards.greenhouse.io"],
    });
    expect(s).toMatchObject({ status: "active", steps: 0, endedAt: null });
    const u = store.browserSessions.update(s.id, {
      status: "handoff",
      handoffReason: "sign in",
      steps: 7,
      lastUrl: "https://boards.greenhouse.io/acme/jobs/1?token=secret#x",
    });
    expect(u).toMatchObject({
      status: "handoff",
      steps: 7,
      lastUrl: "https://boards.greenhouse.io/acme/jobs/1",
    });
    expect(() => store.browserSessions.update(s.id, { status: "bogus" as never })).toThrow(
      /invalid/,
    );
    expect(store.browserSessions.endAllOpen()).toBe(1);
    expect(store.browserSessions.latest(app.id)).toMatchObject({ status: "closed" });
    expect(() => store.browserSessions.update(s.id, { steps: 8 })).toThrow(/ended/);
  });
});

function setup() {
  const t = testStore();
  const ownerId = t.store.users.ensureOwner("Owner").id;
  const job = fixtureJob();
  t.store.jobs.upsert(job);
  return { store: t.store, ownerId, job: job.id };
}
