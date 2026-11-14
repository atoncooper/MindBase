// File artifact spec for the chat transcript (`kind: "file"` in an SSE
// `artifact` frame). The backend emits one of these for every generated /
// edited / exported / uploaded file: sandbox outputs, cloud-drive uploads and
// manuscript exports.
//
// Field shapes and limits mirror the server-side contract
// (app-ts/src/artifacts/file.ts). This module is the client's last line of
// defense before the card renders, so a malformed payload degrades to the
// generic artifact preview in chat-message.tsx instead of breaking the turn.

export type FileArtifactAction = "generated" | "edited" | "exported" | "uploaded";

/** Optional diff stats for code / document rewrites (green +N, red −N). */
export interface FileArtifactChange {
  added: number;
  removed: number;
}

export interface FileArtifactData {
  /** File name including its extension (1..200 chars). */
  name: string;
  /** One-line description of what the file contains (<=200 chars). */
  description?: string;
  /** How the file came to be; the backend defaults to "generated". */
  action?: FileArtifactAction;
  /** Short-lived presigned download / preview URL (http(s) or site-relative). */
  url?: string;
  /** Cloud-drive file id; deep-links to /cloud-drive/<uploadUuid>. */
  uploadUuid?: string;
  /** MIME type, drives the type icon and the image preview (<=120 chars). */
  mime?: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Optional added/removed line counts. */
  change?: FileArtifactChange;
}

const FILE_NAME_MAX = 200;
const FILE_DESCRIPTION_MAX = 200;
const FILE_URL_MAX = 2048;
const FILE_MIME_MAX = 120;
// Defensive cap only: cloud-drive ids are UUID-shaped and far shorter.
const FILE_UPLOAD_UUID_MAX = 256;

const ACTION_VALUES: readonly string[] = ["generated", "edited", "exported", "uploaded"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Accepted URL shapes: absolute http(s) or a site-relative path. Anything else
 * (javascript:, data:, protocol-relative "//host", whitespace) is rejected so
 * a payload cannot smuggle an unsafe link past the card's href.
 */
function isSafeHref(value: string): boolean {
  if (/^https?:\/\/[^\s]+$/i.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//") && !/\s/.test(value);
}

function isOptionalNonEmptyString(value: unknown, maxLength: number): boolean {
  return value === undefined || (isNonEmptyString(value) && value.length <= maxLength);
}

/**
 * Runtime guard for a `kind: "file"` artifact payload. Unknown extra fields
 * (e.g. the backend's stamped spec `version`) are tolerated on purpose: the
 * card only renders the fields it understands.
 */
export function isFileArtifactData(data: unknown): data is FileArtifactData {
  if (!isRecord(data)) return false;
  const { name, description, action, url, uploadUuid, mime, sizeBytes, change } = data;

  if (!isNonEmptyString(name) || name.length > FILE_NAME_MAX) return false;
  if (
    description !== undefined &&
    (typeof description !== "string" || description.length > FILE_DESCRIPTION_MAX)
  ) {
    return false;
  }
  if (action !== undefined && !(typeof action === "string" && ACTION_VALUES.includes(action))) {
    return false;
  }
  if (
    url !== undefined &&
    !(isNonEmptyString(url) && url.length <= FILE_URL_MAX && isSafeHref(url))
  ) {
    return false;
  }
  if (!isOptionalNonEmptyString(uploadUuid, FILE_UPLOAD_UUID_MAX)) return false;
  if (!isOptionalNonEmptyString(mime, FILE_MIME_MAX)) return false;
  if (sizeBytes !== undefined && !isFiniteNonNegative(sizeBytes)) return false;
  if (change !== undefined) {
    if (!isRecord(change)) return false;
    if (!isFiniteNonNegative(change.added) || !isFiniteNonNegative(change.removed)) return false;
  }
  return true;
}

/**
 * Where the card's "open" / "copy link" actions should point: the presigned
 * URL when present, otherwise the cloud-drive deep link. Undefined = no target.
 */
export function fileArtifactHref(data: FileArtifactData): string | undefined {
  if (data.url && isSafeHref(data.url)) return data.url;
  if (data.uploadUuid) return `/cloud-drive/${encodeURIComponent(data.uploadUuid)}`;
  return undefined;
}

/**
 * Map a legacy flat file artifact (`{ name, url?, content_type?, size? }`, the
 * shape emitted before `kind: "file"`) onto the new data contract so old
 * history rows render in the same card. Returns null when the payload carries
 * no usable name (nothing sensible to display).
 */
export function legacyFileArtifactData(
  name: string,
  url?: string,
  contentType?: string,
  size?: number,
): FileArtifactData | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return null;

  const data: FileArtifactData = { name: trimmed.slice(0, FILE_NAME_MAX) };
  if (typeof url === "string" && url.length <= FILE_URL_MAX && isSafeHref(url)) {
    data.url = url;
  }
  if (
    typeof contentType === "string" &&
    contentType.trim().length > 0 &&
    contentType.length <= FILE_MIME_MAX
  ) {
    data.mime = contentType;
  }
  if (typeof size === "number" && isFiniteNonNegative(size)) {
    data.sizeBytes = size;
  }
  return data;
}
