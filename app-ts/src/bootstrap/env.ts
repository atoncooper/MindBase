import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * app-ts runtime env file.
 *
 * Default: `<app-ts>/.env` (next to package.json) — NOT the repo root .env.
 * Ordering follows dotenv conventions: existing process.env wins (compose
 * env_file / real environment overrides never get clobbered by the file).
 *
 * Overrides:
 *   APP_TS_ENV_FILE=/abs/path/.env   explicit file
 *   APP_TS_ENV_DISABLED=1            disable loading entirely
 *
 * Tests must not be polluted by a developer's local app-ts/.env; config/index.ts
 * skips this call under NODE_ENV=test/VITEST. The loader itself stays callable
 * (tests pass APP_TS_ENV_FILE explicitly).
 */

/** app-ts package root (src/bootstrap/env.ts -> src/bootstrap -> src -> app-ts). */
const APP_TS_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function defaultAppTsEnvFile(): string {
  return join(APP_TS_ROOT, ".env");
}

export interface LoadAppTsEnvOptions {
  /** Explicit path; defaults to APP_TS_ENV_FILE or <app-ts>/.env. */
  path?: string;
  /** Let the file replace existing process.env values (default false). */
  override?: boolean;
}

/** Loads the app-ts env file if it exists; returns the resolved path (null when skipped/missing). */
export function loadAppTsEnvFile(options: LoadAppTsEnvOptions = {}): string | null {
  if (process.env.APP_TS_ENV_DISABLED === "1") return null;
  const explicit = options.path?.trim() || process.env.APP_TS_ENV_FILE?.trim();
  const envPath = explicit ? resolve(explicit) : defaultAppTsEnvFile();
  if (!existsSync(envPath)) return null;
  loadDotenv({
    path: envPath,
    override: options.override ?? false,
    quiet: true,
  });
  return envPath;
}
