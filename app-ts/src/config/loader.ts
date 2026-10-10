import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Layered YAML config loader (mirrors the Python app/config convention):
 *   default.yaml (repo defaults) → config.yaml (optional, team-shared)
 *   → local.yaml (personal overrides, gitignored) → environment variables (highest).
 * ${VAR} / ${VAR:default} placeholders in YAML values expand from process.env.
 * Env overrides use SECTION__KEY names derived from the config path
 * (camelCase → SNAKE_CASE), with type inferred from the merged YAML value.
 */

export interface LoadedConfig {
  value: Record<string, unknown>;
  sources: string[];
}

const CONFIG_DIR = "config";

export function loadConfigFiles(configDir: string = CONFIG_DIR): LoadedConfig {
  const files = ["default.yaml", "config.yaml", "local.yaml"].map((name) => join(configDir, name));

  const sources: string[] = [];
  let merged: Record<string, unknown> = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf-8");
    const parsed = parse(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      merged = deepMerge(merged, parsed);
      sources.push(file);
    }
  }
  if (sources.length === 0) {
    throw new Error(`[CONFIG] no config files found (default.yaml is required under "${configDir}/")`);
  }
  expandPlaceholders(merged);
  applyEnvOverrides(merged);
  return { value: merged, sources };
}

// ---------- helpers ----------

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Plain, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function expandPlaceholders(node: unknown): void {
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") {
      node[k] = v.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g, (_, name: string, fallback?: string) =>
        process.env[name] ?? fallback ?? "",
      );
    } else if (isPlainObject(v)) {
      expandPlaceholders(v);
    }
  }
}

function toSnakeUpper(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function coerce(raw: string, typeOf: "string" | "number" | "boolean"): unknown {
  if (typeOf === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeOf === "boolean") {
    return raw === "1" || raw.toLowerCase() === "true";
  }
  return raw;
}

function applyEnvOverrides(node: Plain, path: string[] = []): void {
  for (const [k, v] of Object.entries(node)) {
    const nextPath = [...path, k];
    if (isPlainObject(v)) {
      applyEnvOverrides(v, nextPath);
      continue;
    }
    const envName = nextPath.map(toSnakeUpper).join("__");
    const env = process.env[envName];
    if (env === undefined || v === null) continue;
    const type = typeof v;
    if (type === "number" || type === "boolean" || type === "string") {
      node[k] = coerce(env, type as "string" | "number" | "boolean");
    } else {
      node[k] = env;
    }
  }
}
