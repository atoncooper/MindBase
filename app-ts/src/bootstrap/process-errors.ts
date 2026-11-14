import type { Logger } from "pino";

/**
 * Process-level error net (last line of defense behind route/tool/agent handlers):
 * - unhandledRejection: log at error level and keep serving (a stray rejected promise
 *   must not take the whole service down); every other layer already isolates errors.
 * - uncaughtException: the process is in an undefined state — log fatal with the
 *   Error object (serializer keeps type/message/stack), run the graceful shutdown
 *   path, then exit non-zero.
 * Install once at boot; double installation is a no-op.
 *
 * Records are structured (`{ err }`), never a stringified stack in the message, so
 * log pipelines can filter on `err.type`/`err.message`/level without parsing text.
 */
export function installProcessErrorHandlers(
  log: Logger,
  gracefulShutdown: (reason: string) => Promise<void>,
): void {
  const g = process as unknown as { __mbProcessErrorHandlersInstalled?: boolean };
  if (g.__mbProcessErrorHandlersInstalled) return;
  g.__mbProcessErrorHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    // Normalize non-Error rejections so the err serializer always has a stack.
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error({ err }, "[PROCESS] unhandled rejection");
  });

  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "[PROCESS] uncaught exception, shutting down");
    void gracefulShutdown("uncaughtException")
      .catch((e) => log.error({ err: e instanceof Error ? e : new Error(String(e)) }, "[PROCESS] shutdown failed"))
      .finally(() => process.exit(1));
  });
}
