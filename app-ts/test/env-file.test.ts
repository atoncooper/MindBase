import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  defaultAppTsEnvFile,
  loadAppTsEnvFile,
} from "../src/bootstrap/env.js";

/**
 * app-ts env-file resolution: default <app-ts>/.env, explicit APP_TS_ENV_FILE,
 * existing process.env wins, missing/disabled are no-ops.
 */

let dir = "";
let envFile = "";
const saved: Record<string, string | undefined> = {};

function save(name: string) {
  if (!(name in saved)) saved[name] = process.env[name];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-ts-env-"));
  envFile = join(dir, ".env");
  for (const name of ["APP_TS_ENV_FILE", "APP_TS_ENV_DISABLED", "APP_TS_ENV_TEST_KEY"]) {
    save(name);
    delete process.env[name];
  }
  delete process.env.APP_TS_ENV_TEST_KEY;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("app-ts env file", () => {
  it("defaults to <app-ts>/.env next to package.json", () => {
    const file = defaultAppTsEnvFile().replace(/\\/g, "/");
    expect(basename(file)).toBe(".env");
    expect(file.endsWith("/app-ts/.env")).toBe(true);
  });

  it("loads APP_TS_ENV_FILE", () => {
    writeFileSync(envFile, "APP_TS_ENV_TEST_KEY=from-file\n", "utf8");
    process.env.APP_TS_ENV_FILE = envFile;
    const loaded = loadAppTsEnvFile();
    expect(loaded).toContain(".env");
    expect(process.env.APP_TS_ENV_TEST_KEY).toBe("from-file");
  });

  it("never overrides an existing environment variable", () => {
    writeFileSync(envFile, "APP_TS_ENV_TEST_KEY=from-file\n", "utf8");
    process.env.APP_TS_ENV_TEST_KEY = "from-shell";
    process.env.APP_TS_ENV_FILE = envFile;
    loadAppTsEnvFile();
    expect(process.env.APP_TS_ENV_TEST_KEY).toBe("from-shell");
  });

  it("returns null when the file is missing", () => {
    process.env.APP_TS_ENV_FILE = join(dir, "missing.env");
    expect(loadAppTsEnvFile()).toBeNull();
  });

  it("APP_TS_ENV_DISABLED=1 disables loading", () => {
    writeFileSync(envFile, "APP_TS_ENV_TEST_KEY=from-file\n", "utf8");
    process.env.APP_TS_ENV_FILE = envFile;
    process.env.APP_TS_ENV_DISABLED = "1";
    expect(loadAppTsEnvFile()).toBeNull();
    expect(process.env.APP_TS_ENV_TEST_KEY).toBeUndefined();
  });
});
