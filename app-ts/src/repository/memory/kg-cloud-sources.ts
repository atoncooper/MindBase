import type {
  CloudDocContent,
  CloudDocListPage,
  CloudDocMeta,
  KgCloudSourceStore,
} from "../kg-cloud-sources.js";

/**
 * In-memory KgCloudSourceStore (tests / degraded fallback). Mirrors the
 * app-cloud contract: upload_uuid ASC ordering, cursor = last upload_uuid of a
 * full page, uid isolation.
 */
export class MemoryKgCloudSourceStore implements KgCloudSourceStore {
  private readonly docs = new Map<string, CloudDocContent>();

  /** Test seam: register one document for a uid. */
  seed(uid: string, doc: CloudDocContent): void {
    this.docs.set(`${uid}|${doc.uploadUuid}`, { ...doc });
  }

  async listDocuments(uid: string, opts: { limit: number; cursor?: string }): Promise<CloudDocListPage> {
    const limit = Math.max(Math.floor(opts.limit), 1);
    const prefix = `${uid}|`;
    const all = [...this.docs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, doc]) => doc)
      .sort((a, b) => (a.uploadUuid < b.uploadUuid ? -1 : a.uploadUuid > b.uploadUuid ? 1 : 0));
    const after = opts.cursor ?? "";
    const remaining = after === "" ? all : all.filter((doc) => doc.uploadUuid > after);
    const rows = remaining.slice(0, limit);
    const items: CloudDocMeta[] = rows.map((doc) => ({
      uploadUuid: doc.uploadUuid,
      title: doc.title,
      contentHash: doc.contentHash,
      sizeChars: doc.sizeChars,
    }));
    return { items, nextCursor: items.length === limit ? items[items.length - 1].uploadUuid : null };
  }

  async getDocument(uid: string, uploadUuid: string): Promise<CloudDocContent | undefined> {
    const doc = this.docs.get(`${uid}|${uploadUuid}`);
    return doc ? { ...doc } : undefined;
  }

  async close(): Promise<void> {}
}
