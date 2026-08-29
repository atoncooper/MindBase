/**
 * Typed access to the Bilibili login + favorites commands
 * (`bili_*` on the Rust side).
 *
 * Security contract: SESSDATA / bili_jct / refresh_token never leave the
 * Rust layer — account data is limited to mid / uname / face / loggedInAt.
 *
 * Error contract: every "not logged in / cookie expired" failure is a
 * string starting with AUTH_EXPIRED_PREFIX; match it with
 * {@link isAuthExpiredError} to decide when to open the login dialog.
 */

import { invoke } from "@tauri-apps/api/core";

/** Error-prefix sentinel shared with the Rust backend — keep in sync. */
export const AUTH_EXPIRED_PREFIX = "登录已失效";

/** True when an invoke rejection means "scan again". */
export function isAuthExpiredError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith(AUTH_EXPIRED_PREFIX);
}

/** Account facts safe to display (no credential fields). */
export interface BiliAccount {
  mid: number;
  uname: string;
  face: string;
  loggedInAt: number;
}

export interface QrLoginStart {
  qrcodeKey: string;
  /** Content to encode into the QR image (the mobile app scans this URL). */
  qrUrl: string;
}

export interface QrPollState {
  state: "waiting" | "scanned" | "expired" | "confirmed";
  /** Present only when state === "confirmed". */
  account: BiliAccount | null;
}

export interface BiliFavoriteFolder {
  mediaId: number;
  title: string;
  mediaCount: number;
  isDefault: boolean;
}

export interface BiliVideoItem {
  bvid: string;
  title: string;
  cover: string;
  durationSec: number;
  upperName: string;
  invalid: boolean;
}

export interface BiliVideoPage {
  folderTitle: string;
  totalCount: number;
  page: number;
  hasMore: boolean;
  videos: BiliVideoItem[];
}

/** One 分P (part) of a video. */
export interface BiliPageItem {
  cid: number;
  /** 1-based position inside the video. */
  index: number;
  partTitle: string;
  durationSec: number;
}

/** Video detail behind a folder entry: title + full page list. */
export interface BiliVideoDetail {
  bvid: string;
  title: string;
  upperName: string;
  pages: BiliPageItem[];
}

/** Generate a fresh QR code for scanning. */
export async function biliQrGenerate(): Promise<QrLoginStart> {
  return invoke<QrLoginStart>("bili_qr_generate");
}

/** Poll once; confirmed resolves with the logged-in account. */
export async function biliQrPoll(qrcodeKey: string): Promise<QrPollState> {
  return invoke<QrPollState>("bili_qr_poll", { qrcodeKey });
}

/** Read-only local session check (no network; instant). */
export async function biliSessionStatus(): Promise<BiliAccount | null> {
  return invoke<BiliAccount | null>("bili_session_status");
}

/**
 * Probe whether the stored cookies still work (network call to nav);
 * refreshes the cached uname/face on success.
 */
export async function biliSessionVerify(): Promise<BiliAccount> {
  return invoke<BiliAccount>("bili_session_verify");
}

/** Forget the stored session (idempotent logout). */
export async function biliLogout(): Promise<void> {
  return invoke<void>("bili_logout");
}

/** List every favorites folder of the logged-in user (default folder first). */
export async function biliListFolders(): Promise<BiliFavoriteFolder[]> {
  return invoke<BiliFavoriteFolder[]>("bili_list_folders");
}

/** Fetch one page of a folder's videos (20 per page, like the web app). */
export async function biliListFolderVideos(
  mediaId: number,
  page: number,
): Promise<BiliVideoPage> {
  return invoke<BiliVideoPage>("bili_list_folder_videos", { mediaId, page });
}

/** Fetch a video's detail including every 分P (cid / index / part / duration). */
export async function biliVideoPages(bvid: string): Promise<BiliVideoDetail> {
  return invoke<BiliVideoDetail>("bili_video_pages", { bvid });
}
