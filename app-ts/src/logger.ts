import pino, {
  multistream,
  type DestinationStream,
  type Level,
  type Logger,
  type LoggerOptions,
  type StreamEntry,
} from "pino";
import { createStream } from "rotating-file-stream";
import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { config } from "./config/index.js";
import { getRequestContext } from "./context/request-context.js";

/**
 * Logging infrastructure (enterprise baseline; see docs/logging.md).
 *
 * - stdout always emits pino JSON lines (container log collection).
 * - `log.fileEnabled` adds a rotating file sink: size/interval rotation, gzip
 *   compression and a per-file retention cap via rotating-file-stream.
 * - Every record carries `service`/`env`/`pid`/`hostname` as base fields, and
 *   `request_id`/`uid` via mixin when an HTTP request context is active.
 * - Credentials/tokens are censored at serialization time and `err` keeps
 *   type/message/stack (structured error records, no message string parsing).
 *
 * Options and destination are built by exported factories so tests can exercise
 * them against explicit values instead of the global `config` singleton.
 */

/** Censor value used by the redaction rules. */
export const REDACTED = "[REDACTED]";

/** Default URL length cap for access-log `path` (sanitized). */
export const MAX_URL_CHARS = 512;

/** Query parameters whose values are masked in access-log URLs. */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "key",
  "apikey",
  "signature",
  "sig",
  "code",
  "password",
  "passwd",
  "secret",
  "session",
  "sessionid",
  "ticket",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "privatekey",
  "secretkey",
  "accesskey",
]);

/** pino redaction paths (censor=`[REDACTED]`): headers, credentials, tokens. */
export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  "*.authorization",
  "*.apiKey",
  "*.api_key",
  "*.apikey",
  "*.password",
  "*.secret",
  "*.token",
  "*.accessKey",
  "*.secretKey",
  "*.privateKey",
  "*.credential",
  // Top-level equivalents so a flat log field can never leak either.
  "password",
  "secret",
  "token",
  "apiKey",
  "accessKey",
  "secretKey",
  "privateKey",
  "credential",
];

export interface LogRotationOptions {
  enabled: boolean;
  /** rotate at this live-file size (e.g. "20M") */
  size: string;
  /** rotate on this interval (e.g. "1d") */
  interval: string;
  /** rotated files to keep */
  maxFiles: number;
  /** "gzip" (or true) compresses rotated files; "none"/false disables */
  compress: string | boolean;
}

export interface LogDestinationOptions {
  dir: string;
  fileName: string;
  rotation: LogRotationOptions;
}

export interface LogOptionsOverrides {
  level?: string;
  service?: string;
  env?: string;
}

/** Absolute path of the live log file (available even when the file sink is disabled). */
export const logFilePath = resolve(join(config.log.dir, config.log.fileName));

function isSensitiveQueryKey(rawKey: string): boolean {
  const key = rawKey.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_QUERY_KEYS.has(key) || key.startsWith("xamz");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * Sanitize a request URL for access logs:
 * - mask sensitive query values (tokens/keys/signatures/codes/passwords/…),
 * - mask path-carried share tokens (`/notes/shared/<token>`, `/cloud/s/<token>`),
 * - drop the whole query of MinIO pre-signed proxy URLs (`/minio-proxy/…`),
 * - cap the result at `maxLength` (512 by default) so a hostile URL cannot bloat logs.
 */
export function sanitizeUrl(rawUrl: string, maxLength: number = MAX_URL_CHARS): string {
  if (!rawUrl) return "";
  const hashIndex = rawUrl.indexOf("#");
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf("?");
  let path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";

  path = path
    .replace(/\/notes\/shared\/[^/?#]+/i, `/notes/shared/${REDACTED}`)
    .replace(/\/cloud\/s\/[^/?#]+/i, `/cloud/s/${REDACTED}`);

  if (path.startsWith("/minio-proxy/")) {
    return truncate(query ? `${path}?${REDACTED}` : path, maxLength);
  }
  if (!query) return truncate(path, maxLength);

  const maskedQuery = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
      if (!isSensitiveQueryKey(rawKey)) return pair;
      return `${rawKey}=${REDACTED}`;
    })
    .join("&");

  return truncate(`${path}?${maskedQuery}`, maxLength);
}

/** pino options shared by the service logger and by tests. */
export function buildPinoOptions(overrides: LogOptionsOverrides = {}): LoggerOptions {
  return {
    level: overrides.level ?? config.log.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: overrides.service ?? config.log.service,
      env: overrides.env ?? process.env.NODE_ENV ?? "development",
      pid: process.pid,
      hostname: hostname(),
    },
    serializers: { err: pino.stdSerializers.err },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    mixin() {
      const ctx = getRequestContext();
      // No request scope (boot jobs, background workers) → no correlation fields.
      return ctx ? { request_id: ctx.requestId, uid: ctx.uid } : {};
    },
  };
}

function normalizeCompress(compress: string | boolean): boolean | "gzip" {
  if (compress === false || compress === "none") return false;
  return compress === true ? true : "gzip";
}

/**
 * Build the file destination: rotating-file-stream when rotation is enabled,
 * plain pino destination otherwise. The caller owns `end()` (see closeLogger).
 */
export function buildLogDestination(options: LogDestinationOptions): DestinationStream {
  const dir = resolve(options.dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!options.rotation.enabled) {
    return pino.destination({ dest: join(dir, options.fileName), mkdir: true, sync: false });
  }

  const stream = createStream(options.fileName, {
    path: dir,
    size: options.rotation.size,
    interval: options.rotation.interval,
    compress: normalizeCompress(options.rotation.compress),
    maxFiles: options.rotation.maxFiles,
    history: `${options.fileName}.history`,
    immutable: false,
  });
  // A broken log sink must never take the service down: report to stderr only.
  stream.on("error", (err: Error) => {
    process.stderr.write(`[LOG] rotating file stream error: ${err.message}\n`);
  });
  return stream;
}

const streams: StreamEntry<Level>[] = [{ stream: process.stdout }];
let fileDest: DestinationStream | undefined;
if (config.log.fileEnabled) {
  fileDest = buildLogDestination({
    dir: config.log.dir,
    fileName: config.log.fileName,
    rotation: config.log.rotation,
  });
  streams.push({ stream: fileDest });
}

export const rootLogger: Logger = pino(buildPinoOptions(), multistream(streams));

/** Module logger: the module is a structured field; the message keeps the `[MODULE]` prefix. */
export function createLogger(moduleName: string): Logger {
  return rootLogger.child({ module: moduleName });
}

/** One startup line summarizing the logging sink (never prints secrets). */
createLogger("LOG").info(
  {
    sink: config.log.fileEnabled
      ? config.log.rotation.enabled
        ? "stdout+file(rotating)"
        : "stdout+file"
      : "stdout",
    // Never name this field `level`: it would overwrite pino's numeric level.
    log_level: config.log.level,
    dir: config.log.fileEnabled ? resolve(config.log.dir) : undefined,
    rotation: config.log.rotation.enabled
      ? {
          size: config.log.rotation.size,
          interval: config.log.rotation.interval,
          maxFiles: config.log.rotation.maxFiles,
          compress: config.log.rotation.compress,
        }
      : undefined,
    access_log: config.log.accessLog,
  },
  "[LOG] logging configured",
);

/** Close the file sink (flush on graceful shutdown). */
export async function closeLogger(): Promise<void> {
  const dest = fileDest as { end?: (cb?: () => void) => unknown } | undefined;
  if (!dest?.end) return;
  await new Promise<void>((r) => {
    dest.end!(() => r());
  });
}
