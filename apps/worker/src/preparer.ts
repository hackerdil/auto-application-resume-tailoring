import {
  BrowserSession,
  BrowserToolbox,
  adapterFor,
  prepareForm,
  type AtsAdapter,
  type PreparationReport,
} from "@career-agent/browser";
import type { Store } from "@career-agent/db";
import type { FileArtifactStore } from "@career-agent/documents";
import { PolicyError, RunBudget, type ApplicationService } from "@career-agent/domain";
import type { Logger } from "@career-agent/observability";

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
  /** Tests only: allows the local fixture server. Never configurable at runtime. */
  allowPrivateNetwork?: boolean;
}

interface Live {
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
 * preparation runs here; there is no submit path in this process.
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
    const report = await prepareForm(live.toolbox, live.adapter, {
      syncFields: (questions) =>
        this.o.applications.syncPageFields(this.o.ownerId, applicationId, questions, traceId)
          .answers,
    });
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
    const rec = this.o.store.browserSessions.update(live.recordId, {
      status,
      handoffReason: [message, ...report.checklist].join("\n").slice(0, 2000),
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
        `The application page could not be opened (${err instanceof Error ? err.message.split("\n")[0]?.slice(0, 120) : "error"}).`,
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
