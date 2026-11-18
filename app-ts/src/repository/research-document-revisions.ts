import type { AcademicSection } from "./academic.js";

/**
 * Manuscript version history contract.
 *
 * One DocumentRevision is an immutable snapshot of a document's title and
 * sections at a point in time. Revisions are append-only: version numbers are
 * per-document and monotonic starting at 1, and restoring an old version takes a
 * fresh snapshot of the current state first instead of rewriting history.
 *
 * Every read/write is uid-scoped: a foreign document behaves exactly like a
 * missing one (null / empty list), never like a permission error.
 */
export interface DocumentRevision {
  /** snapshot id (uuid) */
  id: string;
  uid: string;
  projectId: string;
  documentId: string;
  /** per-document monotonic version, 1-based */
  version: number;
  title: string;
  sections: AcademicSection[];
  /** why the snapshot was taken (manual reason / pre-restore marker) */
  reason?: string;
  createdAt: number;
}

export interface ResearchDocumentRevisionRepository {
  /** Persist one immutable snapshot (the caller allocates id/version). */
  create(revision: DocumentRevision): Promise<void>;
  /** Snapshots of one document, oldest version first. */
  listByDocument(uid: string, projectId: string, documentId: string): Promise<DocumentRevision[]>;
  /** One snapshot by id, uid-scoped (null when missing or foreign). */
  get(uid: string, id: string): Promise<DocumentRevision | null>;
  /** Highest version of the document, or null when it has no snapshots. */
  latest(uid: string, documentId: string): Promise<DocumentRevision | null>;
  /** 永久删除项目下所有版本快照（级联清理），返回删除条数。 */
  removeByProject(uid: string, projectId: string): Promise<number>;
}

/** Next version number for a document given its current snapshots (1 when none). */
export function nextRevisionVersion(revisions: ReadonlyArray<Pick<DocumentRevision, "version">>): number {
  let max = 0;
  for (const revision of revisions) {
    if (Number.isInteger(revision.version) && revision.version > max) max = revision.version;
  }
  return max + 1;
}
