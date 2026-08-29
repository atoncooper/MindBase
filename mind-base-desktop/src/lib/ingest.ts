/**
 * Typed access to the knowledge-ingestion commands
 * (`ingest_video` / `list_documents` / `delete_document` on the Rust side).
 *
 * Progress flows back through a Tauri `Channel`: each ingestion run pushes
 * {@link IngestEvent}s as the pipeline advances (per 分P start / step /
 * done / failed), so the UI can render a live transcript of the run without
 * any polling.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** Run kicked off for one video. */
export interface IngestStartEvent {
  type: "start";
  bvid: string;
  totalPages: number;
}

/** One 分P began processing. */
export interface IngestPageStartEvent {
  type: "pageStart";
  index: number;
  pageTitle: string;
}

/** Coarse step marker: conclusion | audio | asr | chunk | embed | store. */
export interface IngestPageStepEvent {
  type: "pageStep";
  index: number;
  step: string;
}

/** ASR wait heartbeat while the cloud task is being polled. */
export interface IngestAsrWaitEvent {
  type: "asrWait";
  index: number;
  elapsedSecs: number;
}

/** One 分P finished successfully. */
export interface IngestPageDoneEvent {
  type: "pageDone";
  index: number;
  docId: string;
  chunks: number;
  /** asr | basic_info — basic_info marks the degraded title+desc fallback. */
  source: string;
}

/** One 分P failed; the run continues with the remaining pages. */
export interface IngestPageFailedEvent {
  type: "pageFailed";
  index: number;
  error: string;
}

/** Whole-video run finished. */
export interface IngestDoneEvent {
  type: "done";
  ok: number;
  failed: number;
}

export type IngestEvent =
  | IngestStartEvent
  | IngestPageStartEvent
  | IngestPageStepEvent
  | IngestAsrWaitEvent
  | IngestPageDoneEvent
  | IngestPageFailedEvent
  | IngestDoneEvent;

/** Final tally returned by the ingest command. */
export interface IngestSummary {
  ok: number;
  failed: number;
}

/** One ingested 分P as shown in the workspace document list. */
export interface DocumentRow {
  docId: string;
  bvid: string;
  pageIndex: number;
  videoTitle: string;
  pageTitle: string;
  source: string;
  status: "done" | "failed" | "processing" | "pending";
  error: string;
  chunkCount: number;
  charCount: number;
  embedModel: string;
  embedDim: number;
  updatedAt: number;
  /** Empty for file documents — they have no B站 watch URL. */
  url: string;
  /** video | file */
  sourceType: string;
  /** Absolute local path (file documents only, else empty). */
  filePath: string;
}

/**
 * Ingest every 分P of one video. Resolves when the whole run finishes;
 * progress events arrive on `onEvent` meanwhile.
 */
export async function ingestVideo(
  bvid: string,
  onEvent: (event: IngestEvent) => void,
): Promise<IngestSummary> {
  const channel = new Channel<IngestEvent>();
  channel.onmessage = onEvent;
  return invoke<IngestSummary>("ingest_video", { bvid, onEvent: channel });
}

/**
 * Ingest a single 分P of one video. Resolves when that page's run finishes;
 * progress events arrive on `onEvent` meanwhile.
 */
export async function ingestPage(
  bvid: string,
  pageIndex: number,
  onEvent: (event: IngestEvent) => void,
): Promise<IngestSummary> {
  const channel = new Channel<IngestEvent>();
  channel.onmessage = onEvent;
  return invoke<IngestSummary>("ingest_video", { bvid, pageIndex, onEvent: channel });
}

/** List every ingested document, newest first. */
export function listDocuments(): Promise<DocumentRow[]> {
  return invoke<DocumentRow[]>("list_documents");
}

/** Delete one document's vectors and metadata row; resolves to rows removed. */
export function deleteDocument(docId: string): Promise<number> {
  return invoke<number>("delete_document", { docId });
}
