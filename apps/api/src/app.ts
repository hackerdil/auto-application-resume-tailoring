import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { AppConfig } from "@career-agent/config";
import type { Store } from "@career-agent/db";
import {
  ApplicationService,
  DiscoveryService,
  FactBankService,
  MatchingService,
  TailoringService,
  ProfileService,
  type DiscoveryPorts,
  type DocumentPorts,
} from "@career-agent/domain";
import { createDiscoveryPorts } from "@career-agent/sources";
import { newTraceId, type Logger } from "@career-agent/observability";
import { ApprovalService, approvalKey } from "@career-agent/security";
import { errorBody, statusFor } from "./http-errors.js";
import { LocalGuard } from "./local-guard.js";
import { registerFactRoutes } from "./routes/facts.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerMatchingRoutes } from "./routes/matching.js";
import { registerResumeRoutes } from "./routes/resumes.js";
import { registerApplicationRoutes } from "./routes/applications.js";
import {
  createArtifactWriter,
  createCoverLetterRenderer,
  createResumeRenderer,
  FileArtifactStore,
} from "@career-agent/documents";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerSystemRoutes } from "./routes/system.js";

export interface AppDeps {
  config: AppConfig;
  store: Store;
  ownerId: string;
  documents: DocumentPorts;
  /** Directory of the content-addressed artifact store (rendered résumés are served from here). */
  artifactDir: string;
  /** Defaults to the real adapters behind the SSRF-safe client; tests inject fixtures. */
  discoveryPorts?: DiscoveryPorts;
  sessionSecret: Buffer;
  logger: Logger;
  maxUploadBytes?: number;
  now?: () => number;
}

export interface RequestContext {
  traceId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps.config;
  const app = Fastify({
    // Pino logger with redaction; typed as the base logger so route modules use the default instance type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- widens the instance's logger generic
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    genReqId: () => newTraceId(),
  });

  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  const guard = new LocalGuard({
    sessionSecret: deps.sessionSecret,
    allowedHosts: new Set(hosts.flatMap((h) => [`${h}:${env.API_PORT}`, `${h}:${env.WEB_PORT}`])),
    allowedOrigins: new Set(hosts.map((h) => `http://${h}:${env.WEB_PORT}`)),
    ...(deps.now ? { now: deps.now } : {}),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: {
      fileSize: deps.maxUploadBytes ?? 10 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 1,
      headerPairs: 50,
    },
  });

  app.decorateRequest("ctx", null as unknown as RequestContext);
  app.addHook("onRequest", async (req, reply) => {
    req.ctx = { traceId: req.id };
    void reply.header("x-trace-id", req.id).header("cache-control", "no-store");
    guard.checkTransport(req);
  });

  app.setErrorHandler((err, req, reply) => {
    const fastifyCode = (err as { code?: string }).code ?? "";
    let status = statusFor(err);
    let body = errorBody(err);
    if (status === 500 && typeof (err as { statusCode?: number }).statusCode === "number") {
      // Fastify/plugin errors (body too large, rate limit, bad JSON, upload limits) carry a safe 4xx status.
      const s = (err as { statusCode: number }).statusCode;
      if (s >= 400 && s < 500) {
        status = s;
        const message =
          fastifyCode === "FST_REQ_FILE_TOO_LARGE" || s === 413
            ? "The upload is too large."
            : s === 429
              ? "Too many requests. Please slow down."
              : "The request could not be processed.";
        body = { error: { code: fastifyCode || "BAD_REQUEST", message } };
      }
    }
    if (status >= 500) req.log.error({ err, traceId: req.ctx.traceId }, "request failed");
    else req.log.warn({ code: body.error.code, traceId: req.ctx.traceId }, "request rejected");
    void reply.code(status).send(body);
  });

  const factBank = new FactBankService({
    uow: deps.store,
    facts: deps.store.facts,
    candidates: deps.store.candidates,
    documentTexts: deps.store.documentTexts,
    artifacts: deps.store.artifacts,
    audit: deps.store.audit,
    documents: deps.documents,
  });
  const profiles = new ProfileService({
    uow: deps.store,
    profiles: deps.store.profiles,
    savedAnswers: deps.store.savedAnswers,
    audit: deps.store.audit,
  });

  const discovery = new DiscoveryService({
    jobs: deps.store.jobs,
    sources: deps.store.jobSources,
    fetches: deps.store.jobFetches,
    profiles: deps.store.profiles,
    audit: deps.store.audit,
    ports: deps.discoveryPorts ?? createDiscoveryPorts(),
    freshnessDays: env.JOB_FRESHNESS_DAYS,
    enableWorkable: env.ENABLE_WORKABLE,
  });

  // Provider-backed analysis arrives with the provider implementations (Phase 9); scoring here is deterministic.
  const matching = new MatchingService({
    jobs: deps.store.jobs,
    facts: deps.store.facts,
    profiles: deps.store.profiles,
    savedAnswers: deps.store.savedAnswers,
    matches: deps.store.matches,
    requirements: deps.store.jobRequirements,
    providerRuns: deps.store.providerRuns,
    audit: deps.store.audit,
    strongThreshold: env.MATCH_SCORE_THRESHOLD,
    analyzer: null,
  });

  const files = new FileArtifactStore(deps.artifactDir);
  // Tailoring runs in the worker; the API uses this instance only to record approve/reject decisions.
  const tailoring = new TailoringService({
    jobs: deps.store.jobs,
    facts: deps.store.facts,
    profiles: deps.store.profiles,
    matches: deps.store.matches,
    resumes: deps.store.resumes,
    providerRuns: deps.store.providerRuns,
    audit: deps.store.audit,
    renderer: createResumeRenderer(),
    artifacts: createArtifactWriter(files, deps.store.artifacts),
  });

  // Cover letters render in the worker; drafting with a model arrives in Phase 9.
  const applications = new ApplicationService({
    applications: deps.store.applications,
    fields: deps.store.applicationFields,
    coverLetters: deps.store.coverLetters,
    resumes: deps.store.resumes,
    jobs: deps.store.jobs,
    facts: deps.store.facts,
    profiles: deps.store.profiles,
    savedAnswers: deps.store.savedAnswers,
    providerRuns: deps.store.providerRuns,
    audit: deps.store.audit,
    renderer: createCoverLetterRenderer(),
    artifacts: createArtifactWriter(files, deps.store.artifacts),
    drafter: null,
    approvals: deps.store.approvals,
    uow: (fn) => deps.store.transaction(fn),
  });

  const shared = { guard, store: deps.store, ownerId: deps.ownerId };
  registerSystemRoutes(app, { ...shared, config: deps.config });
  registerProfileRoutes(app, { ...shared, profiles });
  registerFactRoutes(app, { ...shared, factBank });
  registerJobRoutes(app, { ...shared, discovery, matching });
  registerMatchingRoutes(app, {
    ...shared,
    matching,
    maxJobsScoredPerRun: env.MAX_JOBS_SCORED_PER_RUN,
  });
  registerResumeRoutes(app, { ...shared, tailoring, files });
  // Phase 8: approvals are signed with a key derived from LOCAL_SESSION_SECRET (docs/APPROVAL_MODEL.md §2).
  const approvals = new ApprovalService({
    approvals: deps.store.approvals,
    applications: deps.store.applications,
    attempts: deps.store.submissionAttempts,
    audit: deps.store.audit,
    uow: (fn) => deps.store.transaction(fn),
    key: approvalKey(deps.sessionSecret),
    ttlSeconds: env.APPROVAL_TTL_SECONDS,
    mode: env.OPERATING_MODE,
  });
  registerApplicationRoutes(app, {
    ...shared,
    applications,
    approvals,
    files,
    sessionSecret: deps.sessionSecret,
    ttlSeconds: env.APPROVAL_TTL_SECONDS,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return app;
}
