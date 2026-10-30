import {
  BrowserSession,
  BrowserToolbox,
  adapterFor,
  MODEL_TOOLS,
  prepareForm,
  snapshotHash,
  submitControlIdentity,
  type AtsAdapter,
  type PreparationReport,
} from "@career-agent/browser";
import {
  FORM_PREPARATION_PROMPT,
  FormPreparationOutput,
  orchestrate,
  renderFormPreparation,
  type AIProvider,
  type OpenAIAgentsProvider,
  type OrchestratorTool,
} from "@career-agent/ai";
import type { Store } from "@career-agent/db";
import type { FileArtifactStore } from "@career-agent/documents";
import {
  normalizeQuestion,
  PolicyError,
  RunBudget,
  type ApplicationService,
  type PageQuestion,
  type ReviewSnapshot,
  type RunLimits,
} from "@career-agent/domain";
import type { Logger } from "@career-agent/observability";
import { redactString } from "@career-agent/security";

export interface PreparerOptions {
  store: Store;
  applications: ApplicationService;
  files: FileArtifactStore;
  ownerId: string;
  logger: Logger;
  headless: boolean;
  /** Persistent per-origin profiles (keeps the owner's own ATS sign-ins). Omit for throwaway contexts. */
  profileRoot?: string;
  maxSteps: number;
  sessionTimeoutMs: number;
  /** Local fixture forms: tests, and the fictional demo (DEMO_MODE), which also sets `localFormsOnly`. */
  allowPrivateNetwork?: boolean;
  /** Demo: refuse every form that is not on this machine (127.0.0.1, localhost, *.localhost). */
  localFormsOnly?: boolean;
  /** Phase 9 (BROWSER_MODEL_ASSIST): the OpenAI orchestrator continues forms the rule-based pass could not finish. */
  assist?: ModelAssist | null;
}

export interface ModelAssist {
  openai: OpenAIAgentsProvider;
  claude: AIProvider | null;
  maxDelegations: number;
  limits: RunLimits;
  secretValues: readonly string[];
}

export interface Live {
  session: BrowserSession;
  toolbox: BrowserToolbox;
  adapter: AtsAdapter;
  recordId: string;
}

const LIMITS = (maxSteps: number) => ({
  deadlineMs: 300_000,
  maxModelTurns: 1,
  maxToolCalls: 0,
  maxBrowserSteps: maxSteps,
  maxRetries: 0,
  maxInputChars: 1,
  maxOutputTokens: 1,
  maxCostUsd: 0,
});

/**
 * Owns the visible preparation browsers of this worker process (spec §13, Phase 7): one window per application,
 * kept open across hand-offs so the owner can sign in or answer and press Continue. Only deterministic
 * preparation runs here; the submit path is the separate Submitter (Phase 8), which reuses these windows.
 */
export class BrowserPreparer {
  private readonly live = new Map<string, Live>();

  constructor(private readonly o: PreparerOptions) {
    const closed = o.store.browserSessions.endAllOpen();
    if (closed) o.logger.info({ closed }, "closed browser sessions left by an earlier worker");
  }

  async prepare(applicationId: string, traceId: string): Promise<PreparationReport> {
    const overview = this.o.applications.overview(this.o.ownerId, applicationId);
    const state = overview.application.state;
    if (
      !["READY_TO_PREPARE", "PREPARING", "AWAITING_USER_INPUT", "READY_FOR_REVIEW"].includes(state)
    )
      throw new PolicyError(`Approve the résumé and choose a cover letter first (state ${state}).`);
    const live = await this.open(applicationId);
    const budget = new RunBudget(LIMITS(this.o.maxSteps));
    live.toolbox.budget = budget;
    const before = live.toolbox.log.length;
    const ports = {
      syncFields: (questions: PageQuestion[]) =>
        this.o.applications.syncPageFields(this.o.ownerId, applicationId, questions, traceId)
          .answers,
    };
    let report = await prepareForm(live.toolbox, live.adapter, ports);
    if (this.o.assist && (report.status === "stopped" || report.refused.length > 0)) {
      await this.assisted(applicationId, live, report, traceId);
      // The model's own verdict is never trusted: a fresh rule-based pass decides what happens next.
      live.toolbox.budget = new RunBudget(LIMITS(this.o.maxSteps));
      report = await prepareForm(live.toolbox, live.adapter, ports);
    }
    let status: "ready" | "awaiting_input" | "handoff" =
      report.status === "ready"
        ? "ready"
        : report.status === "handoff"
          ? "handoff"
          : "awaiting_input";
    let message = report.message;
    if (report.status === "ready") {
      try {
        this.o.applications.markReadyForReview(
          this.o.ownerId,
          applicationId,
          report.blockers,
          traceId,
        );
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        status = "awaiting_input";
        message = err.message;
      }
    }
    if (status === "ready") await this.review(applicationId);
    const rec = this.o.store.browserSessions.update(live.recordId, {
      status,
      // Checklist items carry field labels and short error texts from the page: capped and redacted.
      handoffReason: [message, ...report.checklist.slice(0, 20).map((c) => c.slice(0, 300))]
        .map((l) => redactString(l))
        .join("\n")
        .slice(0, 2000),
      steps: live.toolbox.log.length,
      lastUrl: report.url || null,
    });
    this.o.store.audit.append({
      traceId,
      runId: null,
      taskId: null,
      applicationId,
      jobId: overview.job.id,
      actor: "system",
      type: "browser.prepared",
      prevState: null,
      newState: null,
      approvalId: null,
      artifactHashes: [],
      provider: null,
      model: null,
      durationMs: null,
      // Counts and outcome only: no field values or page text.
      metadata: {
        status: rec.status,
        adapter: live.adapter.id,
        filled: report.filled,
        refused: report.refused.length,
        pages: report.pages,
        steps: live.toolbox.log.length - before,
        blocked: live.session.blocked.length,
      },
    });
    return { ...report, message };
  }

  /** One orchestrated pass with the 12 answer-bound tools (and delegate_to_claude). Failures are logged, not fatal. */
  private async assisted(
    applicationId: string,
    live: Live,
    report: PreparationReport,
    traceId: string,
  ): Promise<void> {
    const assist = this.o.assist;
    if (!assist) return;
    const answers = this.o.applications
      .answersFor(this.o.ownerId, applicationId)
      .filter((a) => a.finalValue !== null && a.decision !== "prohibited")
      .map((a) => ({ fieldId: a.field.id, label: a.field.label, category: a.field.category }));
    const snapshot = live.toolbox.snapshot;
    const pageSummary = snapshot
      ? JSON.stringify(live.toolbox.modelView(snapshot)).slice(0, 30_000)
      : "(not inspected yet)";
    const tools: OrchestratorTool[] = MODEL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input: t.input,
      call: (input: unknown) => live.toolbox.call(t.name, input),
    }));
    try {
      const out = await orchestrate({
        openai: assist.openai,
        claude: assist.claude,
        maxDelegations: assist.maxDelegations,
        tools,
        taskType: "form_preparation",
        prompt: FORM_PREPARATION_PROMPT,
        messages: renderFormPreparation({
          checklist: [report.message, ...report.checklist],
          answers,
          pageSummary,
        }),
        schema: FormPreparationOutput,
        limits: assist.limits,
        signal: AbortSignal.timeout(assist.limits.deadlineMs),
        traceId,
        secretValues: assist.secretValues,
        onRun: (r) => {
          this.o.store.providerRuns.record(r);
        },
      });
      this.o.logger.info(
        { status: out.value.status, toolCalls: out.toolCalls, delegations: out.delegations },
        "model-assisted preparation finished",
      );
    } catch (err) {
      this.o.logger.warn(
        { errorClass: err instanceof Error && "code" in err ? String(err.code) : "error" },
        "model-assisted preparation stopped",
      );
    }
  }

  /** The live window for an application, if this worker has one open. */
  liveFor(applicationId: string): Live | null {
    const l = this.live.get(applicationId);
    return l && !l.session.isClosed && !l.session.page.isClosed() ? l : null;
  }

  /**
   * Phase 8 review snapshot: the form exactly as it stands (including boxes the owner ticked), its hash, the one
   * submit control, and anything still open. Approval is possible only when the checklist is empty.
   */
  async review(applicationId: string): Promise<ReviewSnapshot> {
    const live = this.liveFor(applicationId);
    if (!live) throw new PolicyError("Open the form with Prepare in browser first.");
    const checklist = await live.toolbox.readinessChecklist();
    const s = live.toolbox.snapshot;
    if (!s) throw new PolicyError("The page could not be read.");
    const answers = this.o.applications.answersFor(this.o.ownerId, applicationId);
    for (const f of live.adapter.extractFields(s)) {
      if (f.secret || f.ambiguous || f.type === "file") continue;
      const a = answers.find((x) => x.field.normalizedQuestion === normalizeQuestion(f.label));
      if (!a || a.finalValue === null || a.decision === "prohibited") continue;
      const wanted = a.finalValue.trim().toLowerCase();
      const els = s.elements.filter((e) => f.handles.includes(e.handle));
      const shows =
        f.type === "radio"
          ? els.some((e) => e.checked && e.label.trim().toLowerCase() === wanted)
          : f.type === "checkbox"
            ? els.some((e) => e.checked === /^(yes|true|checked|on|1|y)$/i.test(wanted))
            : // Type-ahead fields may show the chosen suggestion ("Berlin, Germany" for "Berlin"); others must match.
              els.some((e) =>
                e.role === "combobox"
                  ? e.value.trim().toLowerCase().startsWith(wanted)
                  : e.value.trim().toLowerCase() === wanted,
              );
      if (!shows) checklist.push(`Changed on the page: "${f.label}" no longer shows your answer.`);
    }
    const control = live.adapter.submitControl(s);
    if (!control)
      checklist.push("Career Agent could not find exactly one submit button on this page.");
    const review: ReviewSnapshot = {
      formSnapshotHash: snapshotHash(s),
      url: s.url,
      origin: s.origin,
      submitControl: control ? submitControlIdentity(live.adapter, control) : null,
      checklist,
      takenAt: new Date().toISOString(),
    };
    this.o.store.browserSessions.recordReview(live.recordId, review);
    return review;
  }

  async close(applicationId: string): Promise<void> {
    const live = this.live.get(applicationId);
    this.live.delete(applicationId);
    if (live) {
      await live.session.close();
      this.o.store.browserSessions.end(live.recordId, "closed");
      return;
    }
    const rec = this.o.store.browserSessions.latest(applicationId);
    if (rec && !rec.endedAt) this.o.store.browserSessions.end(rec.id, "closed");
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  private async open(applicationId: string): Promise<Live> {
    const existing = this.live.get(applicationId);
    if (existing && !existing.session.isClosed && !existing.session.page.isClosed())
      return existing;
    if (existing) await this.close(applicationId);
    const job = this.o.applications.overview(this.o.ownerId, applicationId).job;
    const url = new URL(job.applyUrl ?? job.sourceUrl);
    if (url.protocol !== "https:" && !this.o.allowPrivateNetwork)
      throw new PolicyError("Only https application pages can be opened.");
    if (
      this.o.localFormsOnly &&
      !/^(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost)$/.test(url.hostname)
    )
      throw new PolicyError("Demo mode only opens the fictional forms on this machine.");
    const probe = adapterFor(url.href);
    const session = await BrowserSession.open({
      policy: {
        allowedOrigins: [url.origin],
        subframeOrigins: [],
        // Until the page identifies itself, every write is blocked (the generic rule).
        blockedWritePatterns: [/.*/],
        allowPrivateNetwork: this.o.allowPrivateNetwork === true,
      },
      headless: this.o.headless,
      ...(this.o.profileRoot ? { profileRoot: this.o.profileRoot } : {}),
      maxDurationMs: this.o.sessionTimeoutMs,
    });
    try {
      await session.page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
    } catch (err) {
      await session.close();
      throw new PolicyError(
        // Error names only: browser messages can contain the full URL, including tokens in its query.
        `The application page could not be opened (${err instanceof Error ? err.name : "error"}). Check the job link and your connection.`,
      );
    }
    const marker =
      (await session.page
        .locator("meta[name='ca-fixture-ats']")
        .first()
        .getAttribute("content", { timeout: 500 })
        .catch(() => null)) ?? "";
    const adapter = marker ? adapterFor(url.href, marker) : probe;
    const answers = {
      answers: () => this.o.applications.answersFor(this.o.ownerId, applicationId),
      approvedFile: (kind: "resume" | "cover_letter") => {
        const ref = this.o.applications.approvedFileRef(this.o.ownerId, applicationId, kind);
        const art = ref ? this.o.store.artifacts.get(ref.artifactId) : null;
        if (!ref || !art || art.sha256 !== ref.sha256) return null;
        const buffer = this.o.files.read(art.storagePath, ref.sha256);
        const name = `${kind === "resume" ? "Resume" : "Cover letter"} - ${job.company}`
          .replace(/[^\p{L}\p{N} .-]+/gu, "")
          .slice(0, 80);
        return { buffer, filename: `${name}.pdf`, mimeType: "application/pdf" };
      },
    };
    const toolbox = new BrowserToolbox(session, {
      interactiveOrigins: new Set([url.origin]),
      answers,
      budget: new RunBudget(LIMITS(this.o.maxSteps)),
    });
    const rec = this.o.store.browserSessions.start(applicationId, {
      adapter: adapter.id,
      originAllowlist: [url.origin],
    });
    const live: Live = { session, toolbox, adapter, recordId: rec.id };
    this.live.set(applicationId, live);
    session.page.on("close", () => {
      if (this.live.get(applicationId) === live) {
        this.live.delete(applicationId);
        this.o.store.browserSessions.end(rec.id, "closed");
      }
    });
    return live;
  }
}
