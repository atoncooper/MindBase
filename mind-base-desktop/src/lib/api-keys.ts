/**
 * Typed access to per-provider API configuration storage
 * (exposed by the Rust `list_api_keys` / `save_provider_config` /
 * `clear_provider_key` commands).
 *
 * Security contract: raw keys never leave the Rust layer — every response
 * carries a masked preview only (`sk-…wxyz`). Configuration lives in the
 * local SQLite database and is never sent anywhere.
 */

import { invoke } from "@tauri-apps/api/core";

/** Non-secret view of one provider's stored configuration. */
export interface ProviderStatus {
  /** Provider identifier, e.g. "dashscope" | "openrouter". */
  provider: string;
  hasKey: boolean;
  /** Masked preview such as "sk-…wxyz"; null when nothing is stored. */
  maskedKey: string | null;
  /** Custom base URL; empty = use the provider default endpoint. */
  baseUrl: string;
  /** Model identifier; empty = unset. */
  model: string;
  /** Unix seconds of the last write; null when no row exists yet. */
  updatedAt: number | null;
  /** True when this is the user-chosen default chat provider. */
  isDefault: boolean;
}

/** Snapshot every known provider, in allowlist order. */
export async function listProviders(): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("list_api_keys");
}

/**
 * Store one provider's full configuration; resolves to refreshed statuses.
 *
 * `key=""` keeps the stored credential (config-only edit);
 * `baseUrl` / `model` empty fall back to provider defaults.
 */
export async function saveProviderConfig(
  provider: string,
  config: { key: string; baseUrl: string; model: string },
): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("save_provider_config", {
    provider,
    key: config.key,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

/** Set (or clear with null) the default chat provider; resolves statuses. */
export async function setDefaultProvider(provider: string | null): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("set_default_provider", { provider });
}

/** Clear one provider's stored key, keeping base URL / model (idempotent). */
export async function clearProviderKey(provider: string): Promise<ProviderStatus[]> {
  return invoke<ProviderStatus[]>("clear_provider_key", { provider });
}

/** Outcome of a backend connectivity probe against one provider. */
export interface ProviderTestResult {
  provider: string;
  ok: boolean;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
  /** The exact URL that was probed (no secret material). */
  endpoint: string;
  /** HTTP status when the server answered; null on transport failure. */
  httpStatus: number | null;
  /** Models advertised by the endpoint when it answered 200. */
  modelCount: number | null;
  /** Human-readable conclusion in Chinese. */
  detail: string;
  /** ASR only: whether the configured model appears in the advertised list. */
  asrModelOk?: boolean | null;
  /** ASR only: outcome of the real transcription probe (consumes quota). */
  asrNote?: string | null;
  /** Embedding only: outcome of the real embedding probe (one tiny call). */
  embeddingNote?: string | null;
}

/**
 * Probe one provider's *stored* configuration (key + base URL) with a
 * `GET <endpoint>/models` request — verifies auth without consuming tokens.
 */
export async function testProviderConfig(provider: string): Promise<ProviderTestResult> {
  return invoke<ProviderTestResult>("test_provider_config", { provider });
}

/** Protocol family used by a provider endpoint. */
export type ProviderProtocol = "openai-completions" | "anthropic-messages";

/** One entry of the backend-driven model provider catalog. */
export interface ProviderCatalogEntry {
  /** Stable provider id (deepseek / zai-coding-cn / kimi-coding / ...). */
  id: string;
  label: string;
  /** Group id: coding / official / aggregator / purpose. */
  group: string;
  groupLabel: string;
  protocol: ProviderProtocol;
  protocolLabel: string;
  /** Official default base URL; empty for the custom provider. */
  defaultBase: string;
  /** Default model when none is stored; empty = model required. */
  defaultModel: string;
  models: string[];
  /** Whether the provider can back the chat UI / default provider. */
  chat: boolean;
  hint: string;
}

/** Snapshot the provider catalog (coding plans, official APIs, aggregators). */
export async function listProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  return invoke<ProviderCatalogEntry[]>("provider_catalog");
}

/** Ask one configured provider for its advertised model list (GET /models). */
export async function listProviderModels(provider: string): Promise<string[]> {
  return invoke<string[]>("list_provider_models", { provider });
}
