import type { ElementHandle } from "playwright";
import { z } from "zod";
import {
  classifyQuestion,
  coverage,
  normalizeQuestion,
  PolicyError,
  tokenSet,
  ValidationError,
  type ApplicationAnswer,
  type RunBudget,
} from "@career-agent/domain";
import { classifyControl } from "./controls.js";
import type { BrowserSession } from "./session.js";
import {
  takeSnapshot,
  type PageSnapshot,
  type SnapshotElement,
  type TakenSnapshot,
} from "./snapshot.js";

/** What the toolbox may put into the page: only the owner's finalized answers and verified approved files. */
export interface AnswerSource {
  answers(): ApplicationAnswer[];
  /** Verified bytes of an approved artifact for this application, or null. */
  approvedFile(
    kind: "resume" | "cover_letter",
  ): { buffer: Buffer; filename: string; mimeType: string } | null;
}

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }
  | { ok: true; paused: "ask_user" | "auth_handoff"; message: string }
  | { ok: true; ready: true; checklist: string[] };

export class ToolRefused extends PolicyError {}

const handle = z.string().regex(/^\d+\.\d+$/, "a handle from the latest inspect_page");
const fieldId = z.uuidv7();

/**
 * The complete model-accessible browser surface (spec §13). Frozen: tests assert this exact set and that no
 * entry can submit, evaluate scripts, navigate freely, or upload arbitrary files (ADR-007).
 */
export const MODEL_TOOLS = Object.freeze([
  {
    name: "inspect_page",
    description:
      "Take a fresh structured snapshot of the current page. Invalidates earlier handles.",
    input: z.object({}),
  },
  {
    name: "list_interactive_elements",
    description: "List the latest snapshot's form fields and buttons compactly.",
    input: z.object({}),
  },
  {
    name: "fill_text_field",
    description: "Type the owner's finalized answer for fieldId into a text field.",
    input: z.object({ handle, fieldId }),
  },
  {
    name: "select_option",
    description: "Choose the owner's finalized answer for fieldId in a select or radio group.",
    input: z.object({ handle, fieldId }),
  },
  {
    name: "set_checkbox",
    description: "Set a non-consent checkbox from the owner's finalized answer for fieldId.",
    input: z.object({ handle, fieldId }),
  },
  {
    name: "upload_approved_file",
    description: "Attach the owner's approved résumé or cover letter to a file input.",
    input: z.object({ handle, file: z.enum(["resume", "cover_letter"]) }),
  },
  {
    name: "click_safe_control",
    description:
      "Click a control that moves within the form (Next, Continue, Add another). Never submits.",
    input: z.object({ handle }),
  },
  {
    name: "scroll",
    description: "Scroll the page.",
    input: z.object({ direction: z.enum(["up", "down"]) }),
  },
  {
    name: "wait_for_page_state",
    description: "Wait for the page to settle.",
    input: z.object({
      state: z.enum(["load", "networkidle"]),
      timeoutMs: z.number().int().min(100).max(10_000).default(5_000),
    }),
  },
  {
    name: "ask_user",
    description: "Pause and ask the owner a question (missing, sensitive, or ambiguous answers).",
    input: z.object({
      question: z.string().min(1).max(500),
      fieldIds: z.array(fieldId).max(20).default([]),
    }),
  },
  {
    name: "request_auth_handoff",
    description: "Pause so the owner can sign in, complete MFA, or solve a CAPTCHA themselves.",
    input: z.object({ reason: z.string().min(1).max(300) }),
  },
  {
    name: "ready_for_review",
    description: "Report that preparation is finished and the owner should review everything.",
    input: z.object({}),
  },
] as const);

export type ModelToolName = (typeof MODEL_TOOLS)[number]["name"];

const TEXT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "search",
  "date",
  "month",
  "textarea",
]);
const TRUTHY = /^(yes|true|checked|on|1|y)$/i;

/** Does the element look like the question this answer belongs to? */
function matchesQuestion(e: SnapshotElement, a: ApplicationAnswer): boolean {
  const label = e.groupLabel || e.label;
  // Questions read from this form must sit on exactly that question (e.g. never "First name" into "Last name").
  if (a.field.origin === "page")
    return normalizeQuestion(a.field.label) === normalizeQuestion(label);
  const c = classifyQuestion(label, a.field.type);
  if (c.category !== "unknown" && c.category === a.field.category) return true;
  const x = tokenSet(label);
  const y = tokenSet(a.field.label);
  return x.size > 0 && coverage(y, x) >= 0.6 && coverage(x, y) >= 0.6;
}

/**
 * Answer-bound browser tools. Text and choices always come from the owner's finalized answers (never free text
 * from a model), files only from verified approved artifacts, and clicks only on known in-form navigation.
 */
export class BrowserToolbox {
  private generation = 0;
  private current: TakenSnapshot | null = null;
  readonly log: { at: string; tool: string; ok: boolean; detail: string }[] = [];

  constructor(
    private readonly session: BrowserSession,
    private readonly opts: {
      readonly interactiveOrigins: ReadonlySet<string>;
      readonly answers: AnswerSource;
      budget: RunBudget;
    },
  ) {
    session.page.on("framenavigated", (f) => {
      if (f === session.page.mainFrame()) this.current = null;
    });
  }

  get snapshot(): PageSnapshot | null {
    return this.current?.snapshot ?? null;
  }

  /** Each preparation pass (start, or Continue after a hand-off) gets a fresh step budget. */
  set budget(b: RunBudget) {
    this.opts.budget = b;
  }

  async call(name: ModelToolName, rawInput: unknown): Promise<ToolOutcome> {
    const tool = MODEL_TOOLS.find((t) => t.name === name);
    if (!tool) return { ok: false, error: `Unknown tool ${name}.` };
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success)
      return {
        ok: false,
        error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    try {
      this.opts.budget.use("browserSteps");
      const out = await this.dispatch(name, parsed.data);
      this.log.push({
        at: new Date().toISOString(),
        tool: name,
        ok: true,
        detail: summarize(name, parsed.data),
      });
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Tool failed.";
      this.log.push({
        at: new Date().toISOString(),
        tool: name,
        ok: false,
        detail: msg.slice(0, 200),
      });
      if (err instanceof PolicyError || err instanceof ValidationError)
        return { ok: false, error: msg };
      if (err instanceof Error && err.name === "BudgetExceededError") throw err;
      return { ok: false, error: "The browser action failed." };
    }
  }

  async inspect(): Promise<PageSnapshot> {
    this.current = await takeSnapshot(
      this.session.page,
      ++this.generation,
      this.opts.interactiveOrigins,
    );
    return this.current.snapshot;
  }

  private async dispatch(name: ModelToolName, i: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case "inspect_page":
        return { ok: true, result: this.modelView(await this.inspect()) };
      case "list_interactive_elements":
        return {
          ok: true,
          result: this.modelView(this.current?.snapshot ?? (await this.inspect())).elements,
        };
      case "fill_text_field":
        return this.fill(String(i["handle"]), String(i["fieldId"]));
      case "select_option":
        return this.select(String(i["handle"]), String(i["fieldId"]));
      case "set_checkbox":
        return this.checkbox(String(i["handle"]), String(i["fieldId"]));
      case "upload_approved_file":
        return this.upload(
          String(i["handle"]),
          i["file"] === "cover_letter" ? "cover_letter" : "resume",
        );
      case "click_safe_control":
        return this.click(String(i["handle"]));
      case "scroll":
        await this.session.page.mouse.wheel(0, i["direction"] === "up" ? -600 : 600);
        return { ok: true, result: "scrolled" };
      case "wait_for_page_state":
        await this.session.page
          .waitForLoadState(i["state"] === "networkidle" ? "networkidle" : "load", {
            timeout: Number(i["timeoutMs"] ?? 5000),
          })
          .catch(() => undefined);
        return { ok: true, result: "settled" };
      case "ask_user":
        return { ok: true, paused: "ask_user", message: String(i["question"]) };
      case "request_auth_handoff":
        return { ok: true, paused: "auth_handoff", message: String(i["reason"]) };
      case "ready_for_review":
        return { ok: true, ready: true, checklist: await this.readinessChecklist() };
    }
  }

  /** Element for a handle from the current generation, re-verified against the live DOM. */
  private async resolve(h: string): Promise<{ el: ElementHandle; info: SnapshotElement }> {
    const cur = this.current;
    if (!cur || !h.startsWith(`${cur.snapshot.generation}.`))
      throw new ValidationError(
        "That handle is from an older view of the page. Call inspect_page again.",
      );
    const entry = cur.handles.get(h);
    const info = cur.snapshot.elements.find((e) => e.handle === h);
    if (!entry || !info) throw new ValidationError("Unknown handle.");
    const live = await entry.handle
      .evaluate(
        (el: {
          isConnected: boolean;
          tagName: string;
          id: string;
          getAttribute(n: string): string | null;
        }) => ({
          c: el.isConnected,
          t: el.tagName.toLowerCase(),
          i: el.id,
          n: el.getAttribute("name") ?? "",
        }),
      )
      .catch(() => null);
    if (!live || !live.c || live.t !== info.tag || live.i !== info.id || live.n !== info.name)
      throw new ValidationError("The page changed. Call inspect_page again.");
    return { el: entry.handle, info };
  }

  private answer(fieldId: string, e: SnapshotElement): { value: string; a: ApplicationAnswer } {
    const a = this.opts.answers.answers().find((x) => x.field.id === fieldId);
    if (!a) throw new ValidationError("Unknown answer field.");
    if (a.decision === "prohibited")
      throw new ToolRefused("That question is completed by the owner, never by Career Agent.");
    if (a.finalValue === null)
      throw new ToolRefused("That answer is not finalized by the owner yet. Use ask_user.");
    if (!matchesQuestion(e, a))
      throw new ToolRefused("This field does not look like the question that answer belongs to.");
    return { value: a.finalValue, a };
  }

  private guardField(e: SnapshotElement): void {
    if (e.secret)
      throw new ToolRefused(
        "Passwords, one-time codes, and similar fields are entered by the owner directly.",
      );
    if (e.disabled) throw new ToolRefused("That field is disabled.");
    const c = classifyQuestion(
      e.groupLabel || e.label,
      e.type === "checkbox" ? "checkbox" : "text",
    );
    if (c.decision === "prohibited")
      throw new ToolRefused(c.reason || "This field is completed by the owner directly.");
  }

  private async fill(h: string, fieldId: string): Promise<ToolOutcome> {
    const { el, info } = await this.resolve(h);
    if (!(TEXT_TYPES.has(info.type) || info.role === "combobox"))
      throw new ToolRefused("fill_text_field only works on text fields.");
    this.guardField(info);
    const { value } = this.answer(fieldId, info);
    await el.fill(value);
    if (
      info.role === "combobox" ||
      info.ariaAutocomplete === "list" ||
      info.ariaAutocomplete === "both"
    ) {
      // Type-ahead: choose the suggestion that matches the owner's answer, if one appears.
      const frame = await el.ownerFrame();
      const option = frame
        ?.locator("[role=option]")
        .filter({
          hasText: new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
        })
        .first();
      if (option && (await option.isVisible({ timeout: 3000 }).catch(() => false))) {
        await option.click();
        return { ok: true, result: "filled and selected the matching suggestion" };
      }
      return { ok: true, result: "filled; no matching suggestion appeared" };
    }
    return { ok: true, result: "filled" };
  }

  private async select(h: string, fieldId: string): Promise<ToolOutcome> {
    const { el, info } = await this.resolve(h);
    this.guardField(info);
    const { value } = this.answer(fieldId, info);
    if (info.tag === "select") {
      if (!info.options.includes(value))
        throw new ToolRefused("The answer is not one of this field's options.");
      await el.selectOption({ label: value });
      return { ok: true, result: "selected" };
    }
    if (info.type === "radio") {
      const group = (this.current?.snapshot.elements ?? []).filter(
        (x) => x.type === "radio" && x.frame === info.frame && x.name === info.name,
      );
      const target = group.find((x) => x.label.trim().toLowerCase() === value.trim().toLowerCase());
      if (!target) throw new ToolRefused("No radio option matches the answer.");
      const { el: radio } = await this.resolve(target.handle);
      await radio.check();
      return { ok: true, result: "selected" };
    }
    throw new ToolRefused("select_option only works on selects and radio groups.");
  }

  private async checkbox(h: string, fieldId: string): Promise<ToolOutcome> {
    const { el, info } = await this.resolve(h);
    if (info.type !== "checkbox") throw new ToolRefused("set_checkbox only works on checkboxes.");
    const c = classifyQuestion(info.label || info.groupLabel, "checkbox");
    if (c.decision === "prohibited" || c.category === "unknown")
      throw new ToolRefused(
        "Consent, terms, declarations, and unrecognized checkboxes are ticked by the owner directly.",
      );
    this.guardField(info);
    const { value } = this.answer(fieldId, info);
    if (TRUTHY.test(value) || value === info.label) await el.check();
    else await el.uncheck();
    return { ok: true, result: "set" };
  }

  private async upload(h: string, kind: "resume" | "cover_letter"): Promise<ToolOutcome> {
    const { el, info } = await this.resolve(h);
    if (info.type !== "file")
      throw new ToolRefused("upload_approved_file only works on file inputs.");
    const c = classifyQuestion(info.label || info.name, "file");
    const expected = kind === "resume" ? "resume_file" : "cover_letter_file";
    if (c.category !== expected)
      throw new ToolRefused(
        `This upload field does not look like it asks for your ${kind === "resume" ? "résumé" : "cover letter"}.`,
      );
    const file = this.opts.answers.approvedFile(kind);
    if (!file)
      throw new ToolRefused(
        `There is no approved ${kind === "resume" ? "résumé" : "cover letter"} for this application.`,
      );
    await el.setInputFiles({ name: file.filename, mimeType: file.mimeType, buffer: file.buffer });
    return { ok: true, result: `attached ${file.filename}` };
  }

  private async click(h: string): Promise<ToolOutcome> {
    const { el, info } = await this.resolve(h);
    const kind = classifyControl(info);
    if (kind === "submit")
      throw new ToolRefused(
        "Submitting is never done by preparation tools. The owner approves and the submission service clicks it (Phase 8).",
      );
    if (kind !== "safe_navigation" && kind !== "option")
      throw new ToolRefused(
        "Only in-form navigation controls (Next, Continue, Add another) can be clicked.",
      );
    await el.click();
    await this.session.page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
    this.current = null;
    return { ok: true, result: "clicked; inspect the page again" };
  }

  /** What the owner must still do before approving: required fields still empty, validation errors, consent boxes. */
  async readinessChecklist(): Promise<string[]> {
    const s = await this.inspect();
    const out: string[] = [];
    const radioGroups = new Map<string, boolean>();
    for (const e of s.elements) {
      if (e.type === "radio")
        radioGroups.set(
          `${e.frame}|${e.name}`,
          (radioGroups.get(`${e.frame}|${e.name}`) ?? false) || e.checked,
        );
    }
    for (const e of s.elements) {
      const label = e.groupLabel || e.label || e.name || "(unlabelled field)";
      const prohibited =
        classifyQuestion(label, e.type === "checkbox" ? "checkbox" : "text").decision ===
        "prohibited";
      if (e.invalid || e.errorText)
        out.push(
          `Fix: "${label}" shows an error${e.errorText ? ` (${e.errorText.slice(0, 120)})` : ""}.`,
        );
      if (!e.required) continue;
      const empty =
        e.type === "checkbox"
          ? !e.checked
          : e.type === "radio"
            ? !radioGroups.get(`${e.frame}|${e.name}`)
            : e.value.trim() === "";
      if (!empty) continue;
      if (prohibited || e.secret)
        out.push(`You complete: "${label}" (Career Agent never fills this).`);
      else if (e.type !== "radio" || out.every((x) => !x.includes(`"${label}"`)))
        out.push(`Still empty: "${label}".`);
    }
    return [...new Set(out)];
  }

  /** The snapshot as a model may see it: no secret values; sensitive answers shown only as "[filled]". */
  modelView(s: PageSnapshot) {
    return {
      url: s.url,
      origin: s.origin,
      title: s.title,
      headings: s.headings,
      signals: { passwordField: s.signals.passwordField, captcha: s.signals.captcha },
      elements: s.elements.map((e) => {
        const c = classifyQuestion(
          e.groupLabel || e.label,
          e.type === "checkbox" ? "checkbox" : "text",
        );
        const sensitive =
          e.secret || c.sensitivity === "sensitive" || c.sensitivity === "protected";
        return {
          handle: e.handle,
          kind: classifyControl(e),
          tag: e.tag,
          type: e.type,
          label: (e.groupLabel ? `${e.groupLabel}: ${e.label}` : e.label).slice(0, 200),
          required: e.required,
          options: e.options.slice(0, 50),
          value: e.value ? (sensitive ? "[filled]" : e.value.slice(0, 200)) : "",
          checked: e.checked,
          invalid: e.invalid,
          error: e.errorText.slice(0, 200),
          text: e.text,
          frame: e.frame,
        };
      }),
    };
  }
}

function summarize(name: string, input: unknown): string {
  // Log handles and field ids, never values.
  const o = input as Record<string, unknown>;
  return [name, o["handle"], o["fieldId"], o["file"], o["direction"]]
    .filter((x) => typeof x === "string")
    .join(" ");
}
