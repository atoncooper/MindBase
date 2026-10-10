import pino, { multistream, type Level, type StreamEntry, type DestinationStream, type Logger } from "pino";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config/index.js";

/**
 * Logging infrastructure: format follows the repo spec (§10) — `[Module] event key=value`.
 * Dual sink: stdout + logs/app-ts.log (pino JSON lines; rotation left for later, the Python side uses the same single file).
 */
export const logFilePath = resolve(join(config.log.dir, config.log.fileName));

const streams: StreamEntry<Level>[] = [{ stream: process.stdout }];
let fileDest: DestinationStream | undefined;
if (config.log.fileEnabled) {
  if (!existsSync(config.log.dir)) {
    mkdirSync(config.log.dir, { recursive: true });
  }
  fileDest = pino.destination({ dest: logFilePath, mkdir: true, sync: false });
  streams.push({ stream: fileDest });
}

export const rootLogger: Logger = pino({ level: config.log.level }, multistream(streams));

/** Module logger: logger.info("[RAG] start bvid=...") — module is bound into structured fields, the prefix goes into the message. */
export function createLogger(moduleName: string): Logger {
  return rootLogger.child({ module: moduleName });
}

/** Close the file sink (flush on graceful shutdown). */
export async function closeLogger(): Promise<void> {
  const dest = fileDest as { end?: (cb?: () => void) => unknown } | undefined;
  if (!dest?.end) return;
  await new Promise<void>((r) => {
    dest.end!(() => r());
  });
}
