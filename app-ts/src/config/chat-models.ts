import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("MODELS");

/**
 * Chat model catalog: the user-selectable models of the chat page.
 *
 * Source of truth is `app-ts/config/model.json` (committed, non-secret). The
 * catalog only lists IDs/labels — every model is still reached through the SAME
 * Higress gateway with `AI_GATEWAY__API_KEY`; no per-model credential exists.
 * `config.llm.model` stays the service default/backstop model (used when the
 * turn carries no explicit choice and as the price/bookkeeping fallback).
 *
 * Path resolution deliberately uses `import.meta.url` (NOT cwd): the file lives
 * next to `config/default.yaml`, so `src/config/chat-models.ts` (tsx) and a
 * compiled `dist/config/chat-models.js` both resolve to `<app-ts>/config/model.json`,
 * and the Docker image (WORKDIR /app, COPY app-ts/) resolves to `/app/config/model.json`.
 */

/** One selectable chat model. */
export interface ChatModelEntry {
  /** Gateway model id (e.g. "z-ai/glm-5.3-flash") — the value the API accepts. */
  id: string;
  /** Display label for the picker. */
  label: string;
  /** Optional one-line description shown under the label. */
  description?: string;
  /**
   * Whether the model accepts image input. Explicit `false` makes the HTTP layer
   * reject image turns with a readable 400; absent = unknown (the capability
   * registry decides, same policy as before this catalog existed).
   */
  vision?: boolean;
}

/** The catalog served by GET /chat/models and used to validate chat bodies. */
export interface ChatModelCatalog {
  /** Model used when a turn carries no explicit `model`. */
  default: string;
  models: ChatModelEntry[];
}

/** Hard caps: a picker with more than this many entries is a config mistake. */
export const MAX_CHAT_MODELS = 20;
export const CHAT_MODEL_ID_MAX_CHARS = 200;
export const CHAT_MODEL_LABEL_MAX_CHARS = 120;
export const CHAT_MODEL_DESCRIPTION_MAX_CHARS = 400;

/** Absolute path of the catalog file, derived from the module URL (cwd-independent). */
export const CHAT_MODELS_FILE = fileURLToPath(new URL("../../config/model.json", import.meta.url));

/** Single-model fallback used when the file is missing/invalid or invalid at runtime. */
function fallbackCatalog(defaultModel: string): ChatModelCatalog {
  const id = defaultModel.trim().length > 0 ? defaultModel.trim() : "default";
  return { default: id, models: [{ id, label: id }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a parsed catalog. ANY structural problem degrades to the single
 * fallback model instead of throwing: the chat page must keep working even with
 * a broken catalog file (the model ids are operator-controlled, not user input).
 *
 * Rules: `default` is a non-empty string present in `models`; 1..MAX models;
 * every id/label is a non-empty trimmed string, ids and labels are unique;
 * optional description is a string; optional vision is a boolean.
 */
export function parseChatModelCatalog(raw: unknown, defaultModel: string): ChatModelCatalog {
  const fallback = (reason: string): ChatModelCatalog => {
    log.warn("[MODELS] 聊天模型目录无效（" + reason + "），回退单一默认模型 " + fallbackCatalog(defaultModel).default);
    return fallbackCatalog(defaultModel);
  };
  if (!isRecord(raw)) return fallback("顶层不是对象");

  const defaultId = typeof raw.default === "string" ? raw.default.trim() : "";
  if (!defaultId) return fallback("缺少 default");

  if (!Array.isArray(raw.models) || raw.models.length === 0) return fallback("models 为空");
  if (raw.models.length > MAX_CHAT_MODELS) {
    return fallback("models 超过 " + MAX_CHAT_MODELS + " 个");
  }

  const models: ChatModelEntry[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (let index = 0; index < raw.models.length; index += 1) {
    const item: unknown = raw.models[index];
    if (!isRecord(item)) return fallback("models[" + index + "] 不是对象");
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!id) return fallback("models[" + index + "].id 为空");
    if (id.length > CHAT_MODEL_ID_MAX_CHARS) return fallback("models[" + index + "].id 过长");
    if (!label) return fallback("models[" + index + "].label 为空");
    if (label.length > CHAT_MODEL_LABEL_MAX_CHARS) return fallback("models[" + index + "].label 过长");
    if (ids.has(id)) return fallback("重复的 id " + id);
    if (labels.has(label)) return fallback("重复的 label " + label);
    if (item.description !== undefined && typeof item.description !== "string") {
      return fallback("models[" + index + "].description 不是字符串");
    }
    if (item.vision !== undefined && typeof item.vision !== "boolean") {
      return fallback("models[" + index + "].vision 不是布尔值");
    }
    const entry: ChatModelEntry = { id, label };
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (description.length > 0) {
      entry.description = description.slice(0, CHAT_MODEL_DESCRIPTION_MAX_CHARS);
    }
    if (typeof item.vision === "boolean") entry.vision = item.vision;
    ids.add(id);
    labels.add(label);
    models.push(entry);
  }

  if (!ids.has(defaultId)) return fallback("default " + defaultId + " 不在 models 中");
  return { default: defaultId, models };
}

/**
 * Loads the catalog from disk (synchronously, once at composition-root time).
 * Missing file / invalid JSON / invalid shape all degrade to
 * `{ default: defaultModel, models: [{ id: defaultModel, label: defaultModel }] }`.
 * The caller passes `config.llm.model` as the fallback id.
 */
export function loadChatModels(defaultModel: string, options: { filePath?: string } = {}): ChatModelCatalog {
  const file = options.filePath ?? CHAT_MODELS_FILE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    log.warn(
      "[MODELS] 读取聊天模型目录失败（" +
        file +
        "），回退单一默认模型 " +
        fallbackCatalog(defaultModel).default +
        "：" +
        (err instanceof Error ? err.message : String(err)),
    );
    return fallbackCatalog(defaultModel);
  }
  return parseChatModelCatalog(raw, defaultModel);
}
