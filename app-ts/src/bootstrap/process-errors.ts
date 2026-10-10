import type { Logger } from "pino";

/**
 * Process-level error net (last line of defense behind route/tool/agent handlers):
 * - unhandledRejection: log at error level and keep serving (a stray rejected promise
 *   must not take the whole service down); every other layer already isolates errors.
 * - uncaughtException: the process is in an undefined state — log fatal with full stack,
 *   run the graceful shutdown path, then exit non-zero.
 * Install once at boot; double installation is a no-op.
 */
export function installProcessErrorHandlers(
  log: Logger,
  gracefulShutdown: (reason: string) => Promise<void>,
): void {
  const g = process as unknown as { __mbProcessErrorHandlersInstalled?: boolean };
  if (g.__mbProcessErrorHandlersInstalled) return;
  g.__mbProcessErrorHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    log.error(
      `[PROCESS] unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
    );
  });

  process.on("uncaughtException", (err) => {
    log.fatal(`[PROCESS] uncaught exception, shutting down: ${err.stack || err.message}`);
    void gracefulShutdown("uncaughtException")
      .catch((e) => log.error(`[PROCESS] shutdown after uncaughtException failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => process.exit(1));
  });
}
