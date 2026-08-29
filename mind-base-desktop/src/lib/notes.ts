/**
 * Typed access to the notes commands (`notes_*` on the Rust side).
 *
 * Saves are guarded by optimistic concurrency: the caller passes the
 * `updatedAt` it last saw and the backend rejects the write when another
 * window changed the note meanwhile. Revision snapshots follow the backend
 * policy (≥30% change after ≥10 minutes) plus a baseline snapshot.
 */

import { invoke } from "@tauri-apps/api/core";

/** List-row shape (no body; carries a short preview snippet). */
export interface NoteListRow {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  charCount: number;
  snippet: string;
}

/** One video anchor attached to a note. */
export interface NoteAnchor {
  id: string;
  bvid: string;
  pageIndex: number;
  seconds: number;
  label: string;
  url: string;
  createdAt: number;
}

/** Full note with body and anchors. */
export interface NoteDetail {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  anchors: NoteAnchor[];
}

export interface RevisionMeta {
  id: string;
  noteId: string;
  charCount: number;
  createdAt: number;
}

export interface UpdateResult {
  updatedAt: number;
  charCount: number;
}

/** Toggle-pin outcome — carries the new baseline for open editors. */
export interface PinResult {
  pinned: boolean;
  /** Post-toggle updatedAt; adopt it or the next save will be rejected. */
  updatedAt: number;
}

/** Search + list notes (置顶优先，其余按更新时间倒序). */
export function listNotes(query?: string): Promise<NoteListRow[]> {
  return invoke<NoteListRow[]>("notes_list", { query: query ?? null });
}

export function createNote(title?: string): Promise<NoteDetail> {
  return invoke<NoteDetail>("note_create", { title: title ?? null });
}

export function getNote(id: string): Promise<NoteDetail> {
  return invoke<NoteDetail>("note_get", { id });
}

/**
 * Save the markdown body. `expectedUpdatedAt` is the concurrency guard —
 * an outdated value rejects with 该笔记已在别处被修改.
 */
export function updateNote(
  id: string,
  content: string,
  expectedUpdatedAt: number,
): Promise<UpdateResult> {
  return invoke<UpdateResult>("note_update", { id, content, expectedUpdatedAt });
}

export function renameNote(id: string, title: string): Promise<void> {
  return invoke<void>("note_rename", { id, title });
}

/**
 * Atomic save of title + body under one optimistic-concurrency guard.
 * Saving as two commands would let the first write bump `updatedAt` and
 * leave the second one's baseline stale (rejected as a conflict on every
 * save), so the backend writes both fields in one transaction.
 */
export function saveNote(
  id: string,
  title: string,
  content: string,
  expectedUpdatedAt: number,
): Promise<UpdateResult> {
  return invoke<UpdateResult>("note_save", { id, title, content, expectedUpdatedAt });
}

export function deleteNote(id: string): Promise<void> {
  return invoke<void>("note_delete", { id });
}

export function togglePin(id: string): Promise<PinResult> {
  return invoke<PinResult>("note_toggle_pin", { id });
}

export function listRevisions(noteId: string): Promise<RevisionMeta[]> {
  return invoke<RevisionMeta[]>("revisions_list", { noteId });
}

export function getRevision(revisionId: string): Promise<{ id: string; content: string; createdAt: number }> {
  return invoke("revision_get", { revisionId });
}

/** Roll back to a revision; resolves to the note's new updatedAt. */
export function restoreRevision(revisionId: string): Promise<number> {
  return invoke<number>("revision_restore", { revisionId });
}

/** Attach a video anchor by URL or bare BV id (fetches the title). */
export function addAnchor(noteId: string, input: string): Promise<NoteAnchor> {
  return invoke<NoteAnchor>("anchor_add", { noteId, input });
}

export function deleteAnchor(anchorId: string): Promise<void> {
  return invoke<void>("anchor_delete", { anchorId });
}
