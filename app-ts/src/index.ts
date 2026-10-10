import { bootstrap } from "./bootstrap/container.js";
import { createLogger } from "./logger.js";

const log = createLogger("BOOT");

bootstrap().catch((err) => {
  log.error(`[BOOT] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
