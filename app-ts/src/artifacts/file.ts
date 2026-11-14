import type { Artifact } from "../context/types.js";

/**
 * File artifacts (kind = "file"): the declarative description of a file the agent
 * generated, edited, exported or uploaded during a turn.
 *
 * The binary never rides the SSE stream. The card carries either a short-lived
 * download URL (sandbox presigned) or a cloud-drive uploadUuid the web client
 * deep-links to (/cloud-drive/<uuid>). Objects are built here from real sandbox
 * / export results - never from free-form model output - so every field is
 * checked before it reaches the client.
 *
 * Keep the field names and limits in sync with
 * frontendv2/lib/artifacts/file-spec.ts (the renderer's runtime guard).
 */

export const FILE_ARTIFACT_KIND = "file";
/** Spec version stamped on every payload (same convention as the interactive specs). */
export const SPEC_VERSION = 1;
export const MAX_NAME_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_URL_CHARS = 2048;
export const MAX_UPLOAD_UUID_CHARS = 200;
export const MAX_MIME_CHARS = 120;
export const MAX_CHANGE_LINES = 1_000_000;

/** What happened to the file; the card renders a matching Chinese action label. */
export type FileArtifactAction = "generated" | "edited" | "exported" | "uploaded";

const FILE_ACTIONS: readonly FileArtifactAction[] = ["generated", "edited", "exported", "uploaded"];
/** Cloud-drive upload id: URL-safe only, so it can be interpolated into a deep link. */
const UPLOAD_UUID_RE = /^[A-Za-z0-9_-]+$/;

/** Fields accepted from tool code; `version` is stamped by the builder. */
export interface FileArtifactInput {
  /** File name including the extension, 1..200 chars. */
  name: string;
  /** One-line explanation shown under the name, <=200 chars. */
  description?: string;
  /** Defaults to "generated". */
  action?: FileArtifactAction;
  /** Short-lived download/preview URL (presigned), <=2048 chars, http(s):// or /-relative. */
  url?: string;
  /** Cloud-drive file id the web client deep-links to. */
  uploadUuid?: string;
  /** MIME type, <=120 chars. */
  mime?: string;
  /** Size in bytes (>= 0). */
  sizeBytes?: number;
  /** Line-level diff counts for code/document edits. */
  change?: { added: number; removed: number };
}

/** Payload shape of a kind="file" artifact (SSE artifact frame). */
export type FileArtifactData = FileArtifactInput & { version: number };

export type FileArtifactBuildResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; error: string };

/**
 * Trim an optional string field: absent/blank stays absent, over-long values are
 * rejected with a readable reason instead of being silently truncated (a cut
 * file name or URL is worse than a dropped card).
 */
function readOptionalText(
  value: unknown,
  label: string,
  max: number,
): { text?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: label + " 必须是字符串" };
  const text = value.trim();
  if (!text) return {};
  if (text.length > max) return { error: label + " 最多 " + max + " 个字符（当前 " + text.length + "）" };
  return { text };
}

/**
 * Build and validate a kind="file" artifact.
 *
 * Never throws: every invalid field is reported as a Chinese error string so the
 * calling tool can decide between dropping the card and telling the model what
 * went wrong.
 */
export function buildFileArtifact(input: FileArtifactInput): FileArtifactBuildResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "文件名不能为空" };
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, error: "文件名最多 " + MAX_NAME_CHARS + " 个字符（当前 " + name.length + "）" };
  }

  const description = readOptionalText(input.description, "description", MAX_DESCRIPTION_CHARS);
  if (description.error) return { ok: false, error: description.error };

  const action = input.action ?? "generated";
  if (!FILE_ACTIONS.includes(action)) {
    return { ok: false, error: "action 只能是 " + FILE_ACTIONS.join(" / ") };
  }

  const url = readOptionalText(input.url, "url", MAX_URL_CHARS);
  if (url.error) return { ok: false, error: url.error };
  if (url.text && !/^https?:\/\//i.test(url.text) && !url.text.startsWith("/")) {
    return { ok: false, error: "url 必须以 http(s):// 或 / 开头" };
  }

  const uploadUuid = readOptionalText(input.uploadUuid, "uploadUuid", MAX_UPLOAD_UUID_CHARS);
  if (uploadUuid.error) return { ok: false, error: uploadUuid.error };
  if (uploadUuid.text && !UPLOAD_UUID_RE.test(uploadUuid.text)) {
    return { ok: false, error: "uploadUuid 只能包含字母、数字、- 和 _" };
  }

  const mime = readOptionalText(input.mime, "mime", MAX_MIME_CHARS);
  if (mime.error) return { ok: false, error: mime.error };

  const sizeBytes = input.sizeBytes;
  if (sizeBytes !== undefined && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
    return { ok: false, error: "sizeBytes 必须是 ≥0 的有限数" };
  }

  const change = input.change;
  if (change !== undefined) {
    if (!change || typeof change !== "object") {
      return { ok: false, error: "change 必须是 { added, removed }" };
    }
    const { added, removed } = change;
    if (!Number.isInteger(added) || !Number.isInteger(removed)) {
      return { ok: false, error: "change.added / change.removed 必须是整数" };
    }
    if (added < 0 || removed < 0 || added > MAX_CHANGE_LINES || removed > MAX_CHANGE_LINES) {
      return { ok: false, error: "change.added / change.removed 必须在 0.." + MAX_CHANGE_LINES + " 之间" };
    }
  }

  const data: FileArtifactData = {
    name,
    ...(description.text ? { description: description.text } : {}),
    action,
    ...(url.text ? { url: url.text } : {}),
    ...(uploadUuid.text ? { uploadUuid: uploadUuid.text } : {}),
    ...(mime.text ? { mime: mime.text } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(change ? { change: { added: change.added, removed: change.removed } } : {}),
    version: SPEC_VERSION,
  };
  return { ok: true, artifact: { kind: FILE_ARTIFACT_KIND, data } };
}
