import { randomBytes } from "node:crypto";
import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { redact } from "@career-agent/security";

export type { Logger } from "pino";

export interface LoggerConfig {
  level?: LoggerOptions["level"];
  /** Exact secret values (API keys etc.) to scrub from every log line. */
  secretValues?: readonly string[];
  base?: Record<string, unknown>;
}

/**
 * Structured logger. Every object and message passes through `redact` so secrets, credentials and
 * sensitive keys never reach the log sink (spec §20.4).
 */
export function createLogger(config: LoggerConfig = {}, destination?: DestinationStream): Logger {
  const extraValues = (config.secretValues ?? []).filter((v) => v.length >= 8);
  const options: LoggerOptions = {
    level: config.level ?? "info",
    base: { app: "career-agent", ...config.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Explicit, minimal request/response fields. Query strings are dropped: they can carry tokens or personal data.
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        path: (req.url ?? "").split("?")[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (err: unknown) =>
        err instanceof Error ? { type: err.name, message: err.message } : { type: typeof err },
    },
    formatters: {
      log: (obj) => redact(obj, { extraValues }) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) =>
          typeof a === "string" ? (redact(a, { extraValues }) as string) : a,
        );
        method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** W3C-compatible 16-byte trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function withTrace(
  logger: Logger,
  traceId: string,
  fields: Record<string, unknown> = {},
): Logger {
  return logger.child({ traceId, ...fields });
}
