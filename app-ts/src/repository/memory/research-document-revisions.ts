import type {
  DocumentRevision,
  ResearchDocumentRevisionRepository,
} from "../research-document-revisions.js";

/**
 * In-process document-revision store (tests + Mongo-unreachable fallback).
 * Snapshots are stored verbatim and cloned on every read/write so callers can
 * never mutate history.
 */
export class MemoryResearchDocumentRevisionRepository implements ResearchDocumentRevisionRepository {
  private readonly revisions = new Map<string, DocumentRevision>();

  async create(revision: DocumentRevision): Promise<void> {
    this.revisions.set(revision.id, structuredClone(revision));
  }

  async listByDocument(uid: string, projectId: string, documentId: string): Promise<DocumentRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          revision.uid === uid && revision.projectId === projectId && revision.documentId === documentId,
      )
      .sort((left, right) => left.version - right.version || left.createdAt - right.createdAt)
      .map((revision) => structuredClone(revision));
  }

  async get(uid: string, id: string): Promise<DocumentRevision | null> {
    const revision = this.revisions.get(id);
    return revision && revision.uid === uid ? structuredClone(revision) : null;
  }

  async latest(uid: string, documentId: string): Promise<DocumentRevision | null> {
    let latest: DocumentRevision | undefined;
    for (const revision of this.revisions.values()) {
      if (revision.uid !== uid || revision.documentId !== documentId) continue;
      if (!latest || revision.version > latest.version) latest = revision;
    }
    return latest ? structuredClone(latest) : null;
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    let removed = 0;
    for (const [id, revision] of [...this.revisions]) {
      if (revision.uid !== uid || revision.projectId !== projectId) continue;
      this.revisions.delete(id);
      removed += 1;
    }
    return removed;
  }
}
