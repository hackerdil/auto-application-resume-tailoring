import { normalizeQuestion, type ApplicationAnswer, type PageQuestion } from "@career-agent/domain";
import type { AtsAdapter, PageField } from "../adapters/index.js";
import type { BrowserToolbox, ModelToolName, ToolOutcome } from "../toolbox.js";

export interface PreparationPorts {
  /** Records the page's questions on the application and returns its current answers. */
  syncFields(questions: PageQuestion[]): ApplicationAnswer[];
}

export type PreparationStatus = "ready" | "awaiting_input" | "handoff" | "stopped";

export interface PreparationReport {
  status: PreparationStatus;
  /** Shown to the owner: what to do next. */
  message: string;
  /** From the readiness check: errors, empty required fields, and fields only the owner completes. */
  checklist: string[];
  /** Items that keep the application out of review (everything except "You complete" items). */
  blockers: string[];
  filled: number;
  refused: { label: string; reason: string }[];
  pages: number;
  url: string;
}

const OWNER_ITEM = /^You complete:/;
const TEXTUAL = new Set(["text", "textarea", "email", "tel", "url", "number", "date"]);

const toQuestion = (f: PageField): PageQuestion => ({
  label: f.label,
  name: f.name,
  type: f.type,
  required: f.required,
  options: f.options,
  ambiguous: f.ambiguous,
});

/**
 * Deterministic form preparation (spec §13, Phase 7): reads each step's questions through the adapter, fills only
 * the owner's finalized answers and approved files through the same answer-bound toolbox a model would use, moves
 * through "Next" steps, and stops for the owner on sign-in/CAPTCHA, missing answers, validation errors, or fields
 * only the owner completes. It cannot submit: the toolbox has no such tool and the network guard blocks the write.
 */
export async function prepareForm(
  toolbox: BrowserToolbox,
  adapter: AtsAdapter,
  ports: PreparationPorts,
  opts: { maxPages?: number } = {},
): Promise<PreparationReport> {
  const refused: PreparationReport["refused"] = [];
  // Read through a function: the snapshot changes across awaits.
  const current = () => toolbox.snapshot;
  let filled = 0;
  let pages = 0;
  const call = async (name: ModelToolName, input: Record<string, unknown>): Promise<ToolOutcome> =>
    toolbox.call(name, input);
  const report = (
    status: PreparationStatus,
    message: string,
    checklist: string[] = [],
  ): PreparationReport => ({
    status,
    message,
    checklist,
    blockers: checklist.filter((c) => !OWNER_ITEM.test(c)),
    filled,
    refused,
    pages,
    url: toolbox.snapshot?.url ?? "",
  });

  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && err.name === "BudgetExceededError")
      return report("stopped", "This pass used its step budget. Press Continue to keep going.");
    throw err;
  }

  async function run(): Promise<PreparationReport> {
    for (let i = 0; i < (opts.maxPages ?? 10); i++) {
      pages++;
      await call("inspect_page", {});
      const s = toolbox.snapshot;
      if (!s) return report("stopped", "The page could not be read.");
      if (s.signals.passwordField || s.signals.captcha)
        return report(
          "handoff",
          s.signals.captcha
            ? "The site shows a CAPTCHA or bot check. Complete it yourself in the browser window, then press Continue."
            : "The site asks you to sign in. Sign in yourself in the browser window (including any verification code), then press Continue.",
        );

      const fields = adapter.extractFields(s);
      const answers = ports.syncFields(fields.filter((f) => !f.secret).map(toQuestion));
      for (const f of fields) {
        if (f.secret || f.ambiguous) continue;
        const a = answers.find((x) => x.field.normalizedQuestion === normalizeQuestion(f.label));
        if (!a || a.decision === "prohibited" || a.finalValue === null) continue;
        const handle = f.handles[0];
        if (!handle) continue;
        const el = s.elements.find((e) => e.handle === handle);
        const current = el?.value.trim().toLowerCase() ?? "";
        const wanted = a.finalValue.trim().toLowerCase();
        let out: ToolOutcome | null = null;
        if (f.type === "file") {
          if (current) continue;
          const kind =
            a.field.category === "resume_file"
              ? "resume"
              : a.field.category === "cover_letter_file"
                ? "cover_letter"
                : null;
          if (kind) out = await call("upload_approved_file", { handle, file: kind });
        } else if (TEXTUAL.has(f.type)) {
          if (current && current.startsWith(wanted)) continue;
          out = await call("fill_text_field", { handle, fieldId: a.field.id });
        } else if (f.type === "select" || f.type === "radio") {
          if (f.type === "select" && current === wanted) continue;
          out = await call("select_option", { handle, fieldId: a.field.id });
        } else if (f.type === "checkbox") {
          out = await call("set_checkbox", { handle, fieldId: a.field.id });
        }
        if (!out) continue;
        if (out.ok) filled++;
        else refused.push({ label: f.label.slice(0, 120), reason: out.error });
      }

      const checklist = await toolbox.readinessChecklist();
      const blockers = checklist.filter((c) => !OWNER_ITEM.test(c));
      const next = current() ? adapter.nextControl(current() ?? s) : null;
      if (!next) {
        const done = await call("ready_for_review", {});
        const final = "checklist" in done ? done.checklist : checklist;
        return report(
          final.some((c) => !OWNER_ITEM.test(c)) ? "awaiting_input" : "ready",
          final.some((c) => !OWNER_ITEM.test(c))
            ? "Some fields still need your answer or show an error."
            : "The form is filled. Review everything in the browser window; Career Agent never submits it for you.",
          final,
        );
      }
      if (blockers.length)
        return report(
          "awaiting_input",
          "Answer the questions this step needs, then press Continue.",
          checklist,
        );
      if (checklist.length)
        return report(
          "handoff",
          "This step has fields only you complete. Fill them in the browser window, then press Continue.",
          checklist,
        );
      const beforeKey = adapter.pageKey(current() ?? s);
      const clicked = await call("click_safe_control", { handle: next.handle });
      if (!clicked.ok)
        return report("stopped", `Could not move to the next step: ${clicked.error}`, checklist);
      await call("wait_for_page_state", { state: "load", timeoutMs: 5000 });
      await call("inspect_page", {});
      const after = current();
      if (after && adapter.pageKey(after) === beforeKey) {
        const errors = await toolbox.readinessChecklist();
        return report(
          "awaiting_input",
          "The form did not accept this step. Check the errors shown.",
          errors,
        );
      }
    }
    return report(
      "stopped",
      "The form has more steps than Career Agent prepares in one pass. Press Continue.",
    );
  }
}
