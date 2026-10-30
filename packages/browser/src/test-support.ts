import {
  AnswerDecision,
  ApplicationAnswer,
  classifyQuestion,
  normalizeQuestion,
  RunBudget,
  uuidv7,
  type PageQuestion,
} from "@career-agent/domain";
import { adapterFor, type AtsAdapter } from "./adapters/index.js";
import type { PreparationPorts } from "./preparation/prepare.js";
import { BrowserSession } from "./session.js";
import { BrowserToolbox, type AnswerSource } from "./toolbox.js";

/** In-memory stand-in for ApplicationService in browser tests: owner answers keyed by question label. */
export class FakeAnswers implements AnswerSource, PreparationPorts {
  readonly list: ApplicationAnswer[] = [];
  constructor(
    public owner: Record<string, string>,
    private readonly files: { resume?: Buffer; cover_letter?: Buffer } = {},
  ) {}

  answers(): ApplicationAnswer[] {
    return this.list;
  }

  approvedFile(kind: "resume" | "cover_letter") {
    const buffer = this.files[kind];
    return buffer ? { buffer, filename: `${kind}.pdf`, mimeType: "application/pdf" } : null;
  }

  syncFields(questions: PageQuestion[]): ApplicationAnswer[] {
    for (const q of questions) {
      const nq = normalizeQuestion(q.label);
      const c = classifyQuestion(q.label, q.type);
      const value =
        q.ambiguous || c.decision === "prohibited" ? null : (this.owner[q.label] ?? null);
      const fileValue =
        c.category === "resume_file" || c.category === "cover_letter_file" ? "approved file" : null;
      const final = value ?? fileValue;
      const decision: AnswerDecision = c.decision === "prohibited" ? "prohibited" : "needs_review";
      const answer = ApplicationAnswer.parse({
        field: {
          id: this.list.find((a) => a.field.normalizedQuestion === nq)?.field.id ?? uuidv7(),
          label: q.label,
          normalizedQuestion: nq,
          type: q.type,
          required: q.required,
          options: q.options,
          category: c.category,
          origin: "page",
        },
        proposedValue: null,
        provenance: final ? { kind: "user" } : { kind: "none" },
        confidence: 1,
        sensitivity: c.sensitivity,
        decision,
        reviewerChanges: [],
        finalValue: final,
        finalValueSetBy: final ? "user" : null,
        notes: [],
      });
      const i = this.list.findIndex((a) => a.field.normalizedQuestion === nq);
      if (i >= 0) this.list[i] = answer;
      else this.list.push(answer);
    }
    return this.list;
  }
}

export const LIMITS = {
  deadlineMs: 120_000,
  maxModelTurns: 1,
  maxToolCalls: 0,
  maxBrowserSteps: 400,
  maxRetries: 0,
  maxInputChars: 10_000,
  maxOutputTokens: 1,
  maxCostUsd: 0,
};

export async function openFixture(
  origin: string,
  path: string,
  answers: FakeAnswers,
): Promise<{ session: BrowserSession; toolbox: BrowserToolbox; adapter: AtsAdapter }> {
  const probe = adapterFor(`${origin}${path}`);
  const session = await BrowserSession.open({
    policy: {
      allowedOrigins: [origin],
      subframeOrigins: [],
      // Every adapter's writes plus the generic catch-all are blocked until the adapter is known.
      blockedWritePatterns: [/.*/],
      allowPrivateNetwork: true,
    },
    headless: true,
    maxDurationMs: 60_000,
  });
  await session.page.goto(`${origin}${path}`);
  const marker = await session.page
    .locator("meta[name='ca-fixture-ats']")
    .getAttribute("content", { timeout: 1000 })
    .catch(() => "");
  const adapter = marker ? adapterFor(`${origin}${path}`, marker) : probe;
  const toolbox = new BrowserToolbox(session, {
    interactiveOrigins: new Set([origin]),
    answers,
    budget: new RunBudget(LIMITS),
  });
  return { session, toolbox, adapter };
}

export const answerFor = (answers: FakeAnswers, label: string): ApplicationAnswer => {
  const a = answers.list.find((x) => x.field.normalizedQuestion === normalizeQuestion(label));
  if (!a) throw new Error(`no answer for ${label}`);
  return a;
};
