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

// --- 签名无感更新（tauri-plugin-updater） ----------------------------------

/** Result of the signed-update channel check (`latest.json`). */
export interface UpdaterMeta {
  currentVersion: string;
  /** False when latest.json says the running version is already current. */
  available: boolean;
  version: string | null;
  notes: string | null;
}

/** Progress pushed while the signed update payload downloads. */
export type UpdaterInstallEvent =
  | { type: "progress"; received: number; totalBytes: number | null }
  | { type: "downloaded" };

/**
 * Check the signed-update channel via tauri-plugin-updater (minisign
 * verified). The found update parks Rust-side until `updaterInstall`.
 */
export async function updaterCheck(): Promise<UpdaterMeta> {
  return invoke<UpdaterMeta>("updater_check");
}

/**
 * Download the pending signed update (progress on `onEvent`) and install it
 * silently. On Windows the app exits itself once the installer launches and
 * is relaunched by the installer; on macOS/Linux the app restarts on success.
 */
export async function updaterInstall(
  onEvent: (event: UpdaterInstallEvent) => void,
): Promise<void> {
  const channel = new Channel<UpdaterInstallEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("updater_install", { onEvent: channel });
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
