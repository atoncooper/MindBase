/**
 * Typed access to the GitHub update check exposed by the Rust
 * `check_update` command.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** Result of a successful update check against the configured repository. */
export interface UpdateInfo {
  /** Version of the running app, e.g. "0.1.0". */
  currentVersion: string;
  /** Latest release version with tag prefixes stripped, e.g. "0.2.0". */
  latestVersion: string;
  /** Whether the latest release is newer than the running app. */
  hasUpdate: boolean;
  /** HTML page of the latest release on GitHub. */
  releaseUrl: string;
  /** Release notes body; null when the release has none. */
  releaseNotes: string | null;
  /** ISO publish timestamp; null when the API omits it. */
  publishedAt: string | null;
}

/** Normalize any rejected value into a readable message. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Query GitHub for the latest desktop release.
 *
 * Rejects with the Rust-side error string on any failure (offline, timeout,
 * rate limit); callers decide whether failures may surface in the UI.
 */
export async function checkUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_update");
}

// --- 应用内下载安装包（in-app installer download） ------------------------

/** Download kicked off. */
export interface UpdateDownloadStartEvent {
  type: "start";
  totalBytes: number;
}

/** Throttled progress heartbeat. */
export interface UpdateDownloadProgressEvent {
  type: "progress";
  received: number;
  totalBytes: number;
}

/** Download finished; the file is ready to launch. */
export interface UpdateDownloadDoneEvent {
  type: "done";
  path: string;
  bytes: number;
}

export type UpdateDownloadEvent =
  | UpdateDownloadStartEvent
  | UpdateDownloadProgressEvent
  | UpdateDownloadDoneEvent;

/** Result of a finished installer download. */
export interface UpdateDownloadSummary {
  path: string;
  bytes: number;
}

/**
 * Download the Windows installer of the release at `releaseUrl` into the
 * app's updates directory. Resolves when the download finishes; progress
 * events arrive on `onEvent` meanwhile.
 */
export async function downloadUpdate(
  releaseUrl: string,
  onEvent: (event: UpdateDownloadEvent) => void,
): Promise<UpdateDownloadSummary> {
  const channel = new Channel<UpdateDownloadEvent>();
  channel.onmessage = onEvent;
  return invoke<UpdateDownloadSummary>("download_update", {
    releaseUrl,
    onEvent: channel,
  });
}

/**
 * Launch a previously downloaded installer. The installer prompts to close
 * the running app and its bundled uninstaller replaces the old version.
 */
export async function runUpdateInstaller(path: string): Promise<void> {
  return invoke<void>("run_update_installer", { path });
}
