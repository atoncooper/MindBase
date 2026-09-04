/**
 * Typed access to the local-file ingestion commands
 * (`scan_import_paths` / `ingest_files` on the Rust side).
 *
 * Progress flows back through a Tauri `Channel`, mirroring `ingest.ts`: each
 * run pushes per-file start / step / done / failed events so the import page
 * renders a live transcript without polling.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** Extensions accepted by the backend scan (keep in sync with file_ingest.rs).
 *  图片（jpg/png/bmp/webp）走本地 OCR 识别入库。 */
export const IMPORT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "pdf",
  "docx",
  "html",
  "htm",
  "jpg",
  "jpeg",
  "png",
  "bmp",
  "webp",
] as const;

/** Run kicked off for one selection batch. */
export interface FileIngestStartEvent {
  type: "start";
  total: number;
}

/** One file began processing. */
export interface FileIngestFileStartEvent {
  type: "fileStart";
  index: number;
  fileName: string;
}

/** Coarse step marker: parse | chunk | embed | store. */
export interface FileIngestFileStepEvent {
  type: "fileStep";
  index: number;
  step: string;
}

/** One file finished successfully. */
export interface FileIngestFileDoneEvent {
  type: "fileDone";
  index: number;
  docId: string;
  chunks: number;
  chars: number;
}

/** One file failed; the run continues with the remaining files. */
export interface FileIngestFileFailedEvent {
  type: "fileFailed";
  index: number;
  error: string;
}

/** One file skipped by the content-hash dedup (no quota consumed). */
export interface FileIngestFileSkippedEvent {
  type: "fileSkipped";
  index: number;
  docId: string;
  reason: string;
}

/** Whole batch finished. */
export interface FileIngestDoneEvent {
  type: "done";
  ok: number;
  failed: number;
  skipped: number;
}

export type FileIngestEvent =
  | FileIngestStartEvent
  | FileIngestFileStartEvent
  | FileIngestFileStepEvent
  | FileIngestFileDoneEvent
  | FileIngestFileFailedEvent
  | FileIngestFileSkippedEvent
  | FileIngestDoneEvent;

/** Final tally returned by the ingest command. */
export interface FileIngestSummary {
  ok: number;
  failed: number;
  /** Files skipped by the content-hash dedup. */
  skipped: number;
}

/** One file the backend would ingest, as produced by the pre-scan. */
export interface ScannedFile {
  path: string;
  name: string;
  size: number;
  ext: string;
}

/**
 * Expand a selection (files and/or folders) into the exact file list that
 * would be ingested, applying the extension / size / count filters.
 */
export function scanImportPaths(paths: string[]): Promise<ScannedFile[]> {
  return invoke<ScannedFile[]>("scan_import_paths", { paths });
}

/**
 * Ingest local files/folders into the knowledge base. Resolves when the
 * whole batch finishes; progress events arrive on `onEvent` meanwhile.
 */
export async function ingestFiles(
  paths: string[],
  onEvent: (event: FileIngestEvent) => void,
): Promise<FileIngestSummary> {
  const channel = new Channel<FileIngestEvent>();
  channel.onmessage = onEvent;
  return invoke<FileIngestSummary>("ingest_files", { paths, onEvent: channel });
}

// --- Web page capture (网页链接入库) -------------------------------------

/** Capture run kicked off for a batch of URLs. */
export interface WebCaptureStartEvent {
  type: "start";
  total: number;
}

/** One URL fetched and saved into the ingest queue. */
export interface WebCaptureUrlDoneEvent {
  type: "urlDone";
  index: number;
  /** Local cache path — push this into the ingest queue. */
  path: string;
  name: string;
  bytes: number;
}

/** One URL failed (anti-bot block, non-HTML, network error…). */
export interface WebCaptureUrlFailedEvent {
  type: "urlFailed";
  index: number;
  error: string;
}

/** Capture run finished. */
export interface WebCaptureDoneEvent {
  type: "done";
  ok: number;
  failed: number;
}

export type WebCaptureEvent =
  | WebCaptureStartEvent
  | WebCaptureUrlDoneEvent
  | WebCaptureUrlFailedEvent
  | WebCaptureDoneEvent;

/** Final tally returned by the capture command. */
export interface CaptureSummary {
  ok: number;
  failed: number;
}

/**
 * Fetch web pages with browser-like headers and save them as local HTML
 * files ready for ingestion. Resolves when the whole batch finishes;
 * progress events arrive on `onEvent` meanwhile.
 */
export async function captureUrls(
  urls: string[],
  onEvent: (event: WebCaptureEvent) => void,
): Promise<CaptureSummary> {
  const channel = new Channel<WebCaptureEvent>();
  channel.onmessage = onEvent;
  return invoke<CaptureSummary>("capture_urls", { urls, onEvent: channel });
}
