/**
 * Typed access to the Rust `ffmpeg_status` command.
 *
 * The command walks a resolution chain (user override -> bundled sidecar ->
 * system PATH) and reports the first ffmpeg binary that actually answers
 * `ffmpeg -version`. It returns an error string when nothing usable exists,
 * which is surfaced here as `error` instead of being thrown, so the UI can
 * render a "not found" badge without try/catch at every call site.
 */

import { invoke } from "@tauri-apps/api/core";

/** Where the detected ffmpeg binary came from. */
export type FfmpegSource = "override" | "bundled" | "system";

/** Details of one working ffmpeg binary. */
export interface FfmpegStatus {
  /** `"override"` | `"bundled"` | `"system"`. */
  source: string;
  /** Version parsed from `-version`, e.g. "7.1.1-essentials". */
  version: string;
  /** Path of the binary that answered. */
  path: string;
}

/** Result of probing for ffmpeg; exactly one of the fields is non-null. */
export interface FfmpegProbeResult {
  /** Detected binary details, null when no usable ffmpeg exists. */
  status: FfmpegStatus | null;
  /** Failure description covering every attempted source, else null. */
  error: string | null;
}

/** Normalize an unknown rejection cause into displayable text. */
function toErrorText(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return String(cause);
}

/**
 * Probe the effective ffmpeg installation.
 *
 * Never rejects: probe failures are normalized into `{ status: null, error }`
 * so callers only deal with one result shape.
 */
export async function getFfmpegStatus(): Promise<FfmpegProbeResult> {
  try {
    const status = await invoke<FfmpegStatus>("ffmpeg_status");
    return { status, error: null };
  } catch (cause) {
    return { status: null, error: toErrorText(cause) };
  }
}

/** Human-readable label for a detected ffmpeg source. */
export function ffmpegSourceLabel(source: string): string {
  switch (source as FfmpegSource) {
    case "bundled":
      return "已内置";
    case "override":
      return "手动指定";
    case "system":
      return "系统版本";
    default:
      return source;
  }
}
