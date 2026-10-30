import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFormFixtureServer, type FormFixtureServer } from "@career-agent/testkit";
import { classifyControl } from "./controls.js";
import { prepareForm } from "./preparation/prepare.js";
import type { BrowserSession } from "./session.js";
import { answerFor, FakeAnswers, openFixture } from "./test-support.js";

const PDF = Buffer.from("%PDF-1.4\n% fixture\n");

let server: FormFixtureServer;
const open: BrowserSession[] = [];

beforeAll(async () => {
  server = await startFormFixtureServer();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await server.close();
});

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}

async function fixture(path: string, answers: FakeAnswers) {
  const f = await openFixture(server.origin, path, answers);
  open.push(f.session);
  return f;
}

const GREENHOUSE_ANSWERS = {
  "First Name *": "Ada",
  "Last Name *": "Example",
  "Email *": "ada@example.com",
  Phone: "+1 555 0100",
  "LinkedIn Profile": "https://www.linkedin.com/in/ada-example",
  "Why do you want to work at Acme Fictional Ltd?": "The posting's focus on data platforms.",
  "Are you legally authorized to work in the country where this job is located? *": "Yes",
  "Will you now or in the future require sponsorship for employment visa status? *": "No",
};

describe("Greenhouse-like form", () => {
  it("fills only owner answers, attaches the approved résumé, and leaves consent and EEO alone", async () => {
    const answers = new FakeAnswers(GREENHOUSE_ANSWERS, { resume: PDF });
    const { session, toolbox, adapter } = await fixture("/greenhouse", answers);
    expect(adapter.id).toBe("greenhouse");
    const report = await prepareForm(toolbox, adapter, answers);
    expect(report.status).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.checklist.join(" ")).toMatch(/You complete: "I agree to the privacy policy/);
    const p = session.page;
    expect(await p.inputValue("#first_name")).toBe("Ada");
    expect(await p.inputValue("#last_name")).toBe("Example");
    expect(await p.inputValue("#auth")).toBe("Yes");
    expect(await p.isChecked("input[name=sponsor][value=no]")).toBe(true);
    expect(await p.inputValue("#resume")).toMatch(/resume\.pdf$/);
    expect(await p.isChecked("#privacy")).toBe(false);
    expect(await p.inputValue("#gender")).toBe("");
    expect(await p.inputValue("input[name=website_hp]")).toBe("");
    expect(server.writes).toEqual([]);
  });

  it("cannot submit: no submit tool, submit controls refused, and document/XHR posts blocked", async () => {
    const answers = new FakeAnswers(GREENHOUSE_ANSWERS, { resume: PDF });
    const { session, toolbox } = await fixture("/greenhouse", answers);
    await toolbox.call("inspect_page", {});
    const submit = toolbox.snapshot?.elements.find((e) => e.text === "Submit Application");
    expect(submit && classifyControl(submit)).toBe("submit");
    const out = await toolbox.call("click_safe_control", { handle: submit?.handle });
    expect(out).toMatchObject({ ok: false });
    // Even page script (or a confused flow) cannot get a write out while preparing.
    const xhr = await session.page.evaluate(() =>
      fetch("/submit", { method: "POST", body: "x" }).then(
        () => "sent",
        () => "blocked",
      ),
    );
    expect(xhr).toBe("blocked");
    await session.page.evaluate("document.getElementById('application-form').submit()");
    await session.page.waitForTimeout(300);
    expect(server.writes).toEqual([]);
    expect(session.blocked.map((b) => b.reason)).toEqual(
      expect.arrayContaining(["form_submission", "submit_endpoint"]),
    );
  });

  it("refuses consent checkboxes and fields the answer does not belong to", async () => {
    const answers = new FakeAnswers(GREENHOUSE_ANSWERS, { resume: PDF });
    const { toolbox, adapter } = await fixture("/greenhouse", answers);
    await toolbox.call("inspect_page", {});
    const snap = must(toolbox.snapshot);
    answers.syncFields(adapter.extractFields(snap));
    const els = snap.elements;
    const consent = must(els.find((e) => e.id === "privacy"));
    const first = answerFor(answers, "First Name *");
    expect(
      await toolbox.call("set_checkbox", { handle: consent.handle, fieldId: first.field.id }),
    ).toMatchObject({ ok: false });
    const last = must(els.find((e) => e.id === "last_name"));
    const out = await toolbox.call("fill_text_field", {
      handle: last.handle,
      fieldId: first.field.id,
    });
    expect(out.ok ? "" : out.error).toMatch(/does not look like the question/);
  });

  it("invalidates handles from an older snapshot", async () => {
    const answers = new FakeAnswers(GREENHOUSE_ANSWERS);
    const { toolbox, adapter } = await fixture("/greenhouse", answers);
    await toolbox.call("inspect_page", {});
    const snap = must(toolbox.snapshot);
    answers.syncFields(adapter.extractFields(snap));
    const old = must(snap.elements.find((e) => e.id === "first_name"));
    await toolbox.call("inspect_page", {});
    const out = await toolbox.call("fill_text_field", {
      handle: old.handle,
      fieldId: answerFor(answers, "First Name *").field.id,
    });
    expect(out.ok ? "" : out.error).toMatch(/older view/);
  });

  it("blocks navigation off the allowlist and closes popups", async () => {
    const { session } = await fixture("/greenhouse", new FakeAnswers({}));
    await session.page.evaluate("void window.open(location.href)");
    await session.page.waitForTimeout(300);
    expect(session.context.pages()).toHaveLength(1);
    expect(session.events.some((e) => e.type === "popup_closed")).toBe(true);
    await expect(session.page.goto("https://example.com/")).rejects.toThrow();
    expect(session.blocked.some((b) => b.reason === "navigation_off_allowlist")).toBe(true);
  });
});

describe("Lever-like form", () => {
  it("chooses the matching type-ahead suggestion and leaves the opt-in alone", async () => {
    const answers = new FakeAnswers(
      {
        "Full name *": "Ada Example",
        "Email *": "ada@example.com",
        "Current location *": "Berlin",
      },
      { resume: PDF },
    );
    const { session, toolbox, adapter } = await fixture("/lever", answers);
    expect(adapter.id).toBe("lever");
    const report = await prepareForm(toolbox, adapter, answers);
    expect(report.status).toBe("ready");
    expect(await session.page.inputValue("#location")).toBe("Berlin, Germany");
    expect(await session.page.isChecked("input[name=alerts]")).toBe(false);
    expect(server.writes).toEqual([]);
  });
});

describe("Ashby-like multi-step form", () => {
  it("moves through steps, stops for a missing required answer, then resumes", async () => {
    const answers = new FakeAnswers(
      {
        "Name *": "Ada Example",
        "Email *": "ada@example.com",
        "Portfolio website": "https://ada.example.com",
        "GitHub profile": "https://github.example.com/ada",
      },
      { resume: PDF },
    );
    const { session, toolbox, adapter } = await fixture("/ashby", answers);
    expect(adapter.id).toBe("ashby");
    const first = await prepareForm(toolbox, adapter, answers);
    expect(first.status).toBe("awaiting_input");
    expect(first.blockers.join(" ")).toMatch(/How did you hear about us/);
    // Shadow-DOM and same-origin iframe fields are read and filled.
    expect(await session.page.locator("ca-field input").inputValue()).toBe(
      "https://ada.example.com",
    );
    expect(await session.page.frameLocator("#extra-frame").locator("#github").inputValue()).toBe(
      "https://github.example.com/ada",
    );
    // The unlabelled question is never guessed.
    expect(await session.page.inputValue("input[name=q_unlabeled]")).toBe("");

    answers.owner["How did you hear about us? *"] = "A friend";
    const second = await prepareForm(toolbox, adapter, answers);
    expect(second.status).toBe("ready");
    expect(await session.page.isVisible("text=Step 3 of 3")).toBe(true);
    expect(server.writes).toEqual([]);
  });
});

describe("hand-offs and redaction", () => {
  it("hands sign-in to the owner and never exposes secret values", async () => {
    const { session, toolbox, adapter } = await fixture("/login", new FakeAnswers({}));
    await session.page.fill("#pw", "fixture-secret-value");
    await session.page.fill("#otp", "123456");
    const report = await prepareForm(toolbox, adapter, new FakeAnswers({}));
    expect(report.status).toBe("handoff");
    expect(report.message).toMatch(/sign in/i);
    const view = JSON.stringify(toolbox.modelView(must(toolbox.snapshot)));
    expect(view).not.toContain("fixture-secret-value");
    expect(view).not.toContain("123456");
    expect(JSON.stringify(toolbox.log)).not.toContain("fixture-secret-value");
  });

  it("hands CAPTCHA pages to the owner without touching the widget", async () => {
    const answers = new FakeAnswers({ "First Name": "Ada" });
    const { session, toolbox, adapter } = await fixture("/captcha", answers);
    const report = await prepareForm(toolbox, adapter, answers);
    expect(report.status).toBe("handoff");
    expect(report.message).toMatch(/CAPTCHA/);
    expect(report.filled).toBe(0);
    expect(await session.page.inputValue("#first_name")).toBe("");
  });
});
