import path from "node:path";
import { hostname } from "node:os";
import {
  createAIProviders,
  createApplicationDrafter,
  createIntegrityReviewer,
  createMatchAnalyzer,
  createResumeGenerator,
  failureRecorder,
} from "@career-agent/ai";
import { ConfigError, providerSettings } from "@career-agent/config";
import { bootstrap } from "@career-agent/db";
import {
  ApplicationService,
  DiscoveryService,
  MatchingService,
  TailoringService,
} from "@career-agent/domain";
import {
  createArtifactWriter,
  createCoverLetterRenderer,
  createResumeRenderer,
  FileArtifactStore,
} from "@career-agent/documents";
import { createLogger } from "@career-agent/observability";
import { createDiscoveryPorts } from "@career-agent/sources";
import { BrowserPreparer } from "./preparer.js";
import { Submitter } from "./submitter.js";
import { ApprovalService, approvalKey } from "@career-agent/security";
import { Worker } from "./worker.js";

try {
  const { config, store, ownerId, artifactDir } = bootstrap();
  const logger = createLogger({
    level: config.env.LOG_LEVEL,
    base: { app: "career-agent-worker" },
  });
  // Phase 9: OpenAI orchestrator + Claude reviewer behind the router; every path still works without them.
  const settings = providerSettings(config);
  const ai = createAIProviders({ ...settings, onFailure: failureRecorder(store.providerRuns) });
  const model = ai.router.available ? ai.router : null;
  if (!model)
    logger.warn("No AI provider is configured; scoring, tailoring, and drafting stay rule-based.");
  if (config.env.DISCOVERY_SCHEDULE_ENABLED)
    logger.warn("Scheduled discovery is not implemented yet; run discovery from the Sources page.");
  const discovery = new DiscoveryService({
    jobs: store.jobs,
    sources: store.jobSources,
    fetches: store.jobFetches,
    profiles: store.profiles,
    audit: store.audit,
    ports: createDiscoveryPorts(),
    freshnessDays: config.env.JOB_FRESHNESS_DAYS,
    enableWorkable: config.env.ENABLE_WORKABLE,
  });
  const matching = new MatchingService({
    jobs: store.jobs,
    facts: store.facts,
    profiles: store.profiles,
    savedAnswers: store.savedAnswers,
    matches: store.matches,
    requirements: store.jobRequirements,
    providerRuns: store.providerRuns,
    audit: store.audit,
    strongThreshold: config.env.MATCH_SCORE_THRESHOLD,
    analyzer: model ? createMatchAnalyzer(model, { secretValues: settings.secretValues }) : null,
  });
  const tailoring = new TailoringService({
    jobs: store.jobs,
    facts: store.facts,
    profiles: store.profiles,
    matches: store.matches,
    resumes: store.resumes,
    providerRuns: store.providerRuns,
    audit: store.audit,
    renderer: createResumeRenderer(),
    artifacts: createArtifactWriter(new FileArtifactStore(artifactDir), store.artifacts),
    generator: model ? createResumeGenerator(model) : null,
    reviewer: model ? createIntegrityReviewer(model) : null,
  });
  const applications = new ApplicationService({
    applications: store.applications,
    fields: store.applicationFields,
    coverLetters: store.coverLetters,
    resumes: store.resumes,
    jobs: store.jobs,
    facts: store.facts,
    profiles: store.profiles,
    savedAnswers: store.savedAnswers,
    providerRuns: store.providerRuns,
    audit: store.audit,
    renderer: createCoverLetterRenderer(),
    artifacts: createArtifactWriter(new FileArtifactStore(artifactDir), store.artifacts),
    drafter: model ? createApplicationDrafter(model) : null,
    approvals: store.approvals,
    uow: (fn) => store.transaction(fn),
  });
  const preparer = new BrowserPreparer({
    store,
    applications,
    files: new FileArtifactStore(artifactDir),
    ownerId,
    logger,
    headless: config.env.BROWSER_HEADLESS,
    profileRoot: path.resolve(config.env.BROWSER_PROFILE_DIR),
    maxSteps: config.env.BROWSER_MAX_STEPS,
    sessionTimeoutMs: config.env.BROWSER_TIMEOUT_MS,
    // The fictional demo's forms run on this machine; nothing else can be opened then.
    allowPrivateNetwork: config.env.DEMO_MODE,
    localFormsOnly: config.env.DEMO_MODE,
    assist:
      config.env.BROWSER_MODEL_ASSIST && ai.openai
        ? {
            openai: ai.openai,
            claude: ai.claude,
            maxDelegations: config.env.MAX_CLAUDE_DELEGATIONS_PER_RUN,
            limits: {
              deadlineMs: 300_000,
              maxModelTurns: config.env.OPENAI_MAX_TURNS,
              maxToolCalls: config.env.BROWSER_MAX_STEPS,
              maxBrowserSteps: config.env.BROWSER_MAX_STEPS,
              maxRetries: config.env.MAX_PROVIDER_RETRIES,
              maxInputChars: 60_000,
              maxOutputTokens: 4_000,
              maxCostUsd: config.env.OPENAI_MAX_COST_USD_PER_RUN,
            },
            secretValues: settings.secretValues,
          }
        : null,
  });
  if (config.env.BROWSER_MODEL_ASSIST && !ai.openai)
    logger.warn("BROWSER_MODEL_ASSIST needs OpenAI; preparation stays rule-based.");
  // Phase 8: submission needs LOCAL_SESSION_SECRET (approval MACs) and review-each mode.
  const sessionSecret = config.env.LOCAL_SESSION_SECRET
    ? Buffer.from(config.env.LOCAL_SESSION_SECRET, "base64")
    : null;
  if (!sessionSecret)
    logger.warn("LOCAL_SESSION_SECRET is not set; approved submissions are disabled.");
  const submitter = sessionSecret
    ? new Submitter({
        store,
        applications,
        approvals: new ApprovalService({
          approvals: store.approvals,
          applications: store.applications,
          attempts: store.submissionAttempts,
          audit: store.audit,
          uow: (fn) => store.transaction(fn),
          key: approvalKey(sessionSecret),
          ttlSeconds: config.env.APPROVAL_TTL_SECONDS,
          mode: config.env.OPERATING_MODE,
        }),
        preparer,
        files: new FileArtifactStore(artifactDir),
        ownerId,
        sessionSecret,
        mode: config.env.OPERATING_MODE,
        logger,
      })
    : undefined;
  const controller = new AbortController();
  const worker = new Worker({
    store,
    discovery,
    matching,
    tailoring,
    applications,
    preparer,
    ...(submitter ? { submitter } : {}),
    ownerId,
    workerId: `${hostname()}:${process.pid}`,
    logger,
    maxJobsScoredPerRun: config.env.MAX_JOBS_SCORED_PER_RUN,
  });
  const stop = () => {
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  logger.info("worker started");
  await worker.run(controller.signal);
  await preparer.closeAll();
  store.close();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
