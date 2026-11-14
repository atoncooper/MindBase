import { bootstrap } from "./bootstrap/container.js";
import { createLogger } from "./logger.js";

const log = createLogger("BOOT");

bootstrap().catch((err) => {
  log.fatal({ err: err instanceof Error ? err : new Error(String(err)) }, "[BOOT] fatal");
  process.exit(1);
});
