import type { AppCloudClient } from "../../auth/app-cloud-client.js";
import type {
  CloudDocContent,
  CloudDocListPage,
  CloudDocMeta,
  KgCloudSourceStore,
} from "../kg-cloud-sources.js";

/**
 * app-cloud implementation of KgCloudSourceStore.
 *
 * Only message↔domain mapping lives here: apikey / X-Uid transport, baseUrl
 * trimming, timeouts and the {"detail"} error convention stay in
 * auth/app-cloud-client.ts (same split as repository/grpc vs transport/grpc).
 */
export class HttpKgCloudSourceStore implements KgCloudSourceStore {
  constructor(private readonly client: AppCloudClient) {}

  async listDocuments(uid: string, opts: { limit: number; cursor?: string }): Promise<CloudDocListPage> {
    const page = await this.client.listKgDocuments(uid, { limit: opts.limit, cursor: opts.cursor });
    const items: CloudDocMeta[] = page.items.map((doc) => ({
      uploadUuid: doc.upload_uuid,
      title: doc.title,
      contentHash: doc.content_hash,
      sizeChars: doc.size_chars,
    }));
    return { items, nextCursor: page.next_cursor };
  }

  async getDocument(uid: string, uploadUuid: string): Promise<CloudDocContent | undefined> {
    const doc = await this.client.getKgDocument(uid, uploadUuid);
    if (!doc) return undefined;
    return {
      uploadUuid: doc.upload_uuid,
      title: doc.title,
      contentHash: doc.content_hash,
      sizeChars: doc.size_chars,
      text: doc.text,
    };
  }

  async close(): Promise<void> {}
}
