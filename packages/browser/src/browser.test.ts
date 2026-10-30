import { describe, expect, it } from "vitest";
import {
  adapterFor,
  ashbyAdapter,
  genericAdapter,
  greenhouseAdapter,
  leverAdapter,
} from "./adapters/index.js";
import { classifyControl } from "./controls.js";
import { isSecretField, type PageSnapshot, type SnapshotElement } from "./snapshot.js";
import { MODEL_TOOLS } from "./toolbox.js";

const el = (over: Partial<SnapshotElement>): SnapshotElement => ({
  tag: "input",
  type: "text",
  role: "",
  name: "",
  id: "",
  label: "",
  groupLabel: "",
  placeholder: "",
  required: false,
  value: "",
  checked: false,
  options: [],
  disabled: false,
  visible: true,
  inForm: true,
  formAction: "",
  text: "",
  href: "",
  invalid: false,
  errorText: "",
  autocomplete: "",
  ariaAutocomplete: "",
  accept: "",
  multiple: false,
  shadow: false,
  handle: "1.1",
  frame: "main",
  secret: false,
  ...over,
});

const snap = (elements: SnapshotElement[], headings: string[] = []): PageSnapshot => ({
  generation: 1,
  url: "https://boards.greenhouse.io/acme/jobs/1",
  origin: "https://boards.greenhouse.io",
  title: "Apply",
  headings,
  elements,
  frames: [],
  signals: { passwordField: false, captcha: false, atsMarker: "" },
});

describe("model tool surface (ADR-007)", () => {
  it("is exactly the twelve documented tools", () => {
    expect(MODEL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "inspect_page",
        "list_interactive_elements",
        "fill_text_field",
        "select_option",
        "set_checkbox",
        "upload_approved_file",
        "click_safe_control",
        "scroll",
        "wait_for_page_state",
        "ask_user",
        "request_auth_handoff",
        "ready_for_review",
      ].sort(),
    );
    expect(Object.isFrozen(MODEL_TOOLS)).toBe(true);
  });

  it("has no tool that can submit, run script, navigate, or take free text or paths", () => {
    for (const t of MODEL_TOOLS) {
      expect(t.name).not.toMatch(/submit|eval|script|navigate|goto|url|path|type_text|press|key/);
      const keys = Object.keys(t.input.shape);
      expect(keys).not.toEqual(expect.arrayContaining(["value"]));
      expect(keys).not.toEqual(expect.arrayContaining(["text"]));
      expect(keys).not.toEqual(expect.arrayContaining(["url"]));
      expect(keys).not.toEqual(expect.arrayContaining(["path"]));
      expect(keys).not.toEqual(expect.arrayContaining(["selector"]));
    }
    const upload = MODEL_TOOLS.find((t) => t.name === "upload_approved_file");
    expect(upload?.input.safeParse({ handle: "1.1", file: "/etc/passwd" }).success).toBe(false);
  });
});

describe("control classification", () => {
  it.each([
    ["Submit Application", "submit"],
    ["Apply now", "submit"],
    ["Send", "submit"],
    ["I agree", "submit"],
    ["Finish", "submit"],
    ["Next", "safe_navigation"],
    ["Save and continue", "safe_navigation"],
    ["Continue ›", "safe_navigation"],
    ["Add another", "safe_navigation"],
    ["Do the thing", "unknown"],
  ])("%s → %s", (text, kind) => {
    expect(classifyControl(el({ tag: "button", type: "button", text }))).toBe(kind);
  });

  it("treats unlabelled submit buttons and image inputs as submit", () => {
    expect(classifyControl(el({ tag: "button", type: "submit", text: "→" }))).toBe("submit");
    expect(classifyControl(el({ tag: "input", type: "image" }))).toBe("submit");
    // A "Next" that is a real submit button still only navigates; the network guard blocks any POST it makes.
    expect(classifyControl(el({ tag: "button", type: "submit", text: "Next" }))).toBe(
      "safe_navigation",
    );
  });

  it("recognizes secret fields", () => {
    expect(
      isSecretField({ type: "password", label: "", name: "", autocomplete: "", placeholder: "" }),
    ).toBe(true);
    expect(
      isSecretField({
        type: "text",
        label: "Verification code",
        name: "",
        autocomplete: "",
        placeholder: "",
      }),
    ).toBe(true);
    expect(
      isSecretField({
        type: "text",
        label: "",
        name: "",
        autocomplete: "one-time-code",
        placeholder: "",
      }),
    ).toBe(true);
    expect(
      isSecretField({
        type: "text",
        label: "First name",
        name: "",
        autocomplete: "",
        placeholder: "",
      }),
    ).toBe(false);
  });
});

describe("ATS adapters", () => {
  it("detect by https host, or by fixture marker on loopback only", () => {
    expect(adapterFor("https://boards.greenhouse.io/acme/jobs/1").id).toBe("greenhouse");
    expect(adapterFor("https://jobs.lever.co/acme/1").id).toBe("lever");
    expect(adapterFor("https://jobs.ashbyhq.com/acme/1").id).toBe("ashby");
    expect(adapterFor("https://careers.example.com/1").id).toBe("generic");
    expect(adapterFor("http://boards.greenhouse.io/acme").id).toBe("generic");
    expect(adapterFor("http://127.0.0.1:4000/x", "lever").id).toBe("lever");
    // A page cannot claim to be a known ATS from the public internet.
    expect(adapterFor("https://evil.example.com/x", "greenhouse").id).toBe("generic");
  });

  it("block the known submit endpoints, and generic blocks every write", () => {
    const blocks = (a: typeof greenhouseAdapter, url: string) =>
      a.blockedWritePatterns.some((re) => re.test(url));
    expect(blocks(greenhouseAdapter, "https://boards.greenhouse.io/acme/jobs/1/applications")).toBe(
      true,
    );
    expect(blocks(leverAdapter, "https://jobs.lever.co/acme/1/apply")).toBe(true);
    expect(
      blocks(
        ashbyAdapter,
        "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction",
      ),
    ).toBe(true);
    expect(blocks(genericAdapter, "https://careers.example.com/anything")).toBe(true);
  });

  it("extract one field per radio group, keep stable keys, and flag unlabelled questions", () => {
    const s = snap([
      el({
        handle: "1.1",
        id: "email",
        name: "email",
        type: "email",
        label: "Email *",
        required: true,
      }),
      el({
        handle: "1.2",
        name: "sponsor",
        type: "radio",
        label: "Yes",
        groupLabel: "Need sponsorship?",
      }),
      el({
        handle: "1.3",
        name: "sponsor",
        type: "radio",
        label: "No",
        groupLabel: "Need sponsorship?",
        required: true,
      }),
      el({ handle: "1.4", name: "q1", label: "" }),
      el({
        handle: "1.5",
        tag: "select",
        type: "select",
        name: "auth",
        label: "Authorized?",
        options: ["Select...", "Yes", "No"],
      }),
      el({ handle: "1.6", tag: "button", type: "submit", text: "Submit Application" }),
    ]);
    const fields = greenhouseAdapter.extractFields(s);
    expect(fields.map((f) => [f.label, f.type, f.options, f.ambiguous])).toEqual([
      ["Email *", "email", [], false],
      ["Need sponsorship?", "radio", ["Yes", "No"], false],
      ["q1", "text", [], true],
      ["Authorized?", "select", ["Yes", "No"], false],
    ]);
    expect(fields[1]?.required).toBe(true);
    expect(fields[1]?.handles).toEqual(["1.2", "1.3"]);
    expect(greenhouseAdapter.extractFields(s).map((f) => f.fieldKey)).toEqual(
      fields.map((f) => f.fieldKey),
    );
    expect(greenhouseAdapter.submitControl(s)?.handle).toBe("1.6");
    expect(greenhouseAdapter.nextControl(s)).toBeNull();
  });

  it("only report confirmation on clear wording", () => {
    expect(greenhouseAdapter.isConfirmation(snap([], ["Thank you for applying!"]))).toBe(true);
    expect(greenhouseAdapter.isConfirmation(snap([], ["Apply for this job"]))).toBe(false);
  });
});
