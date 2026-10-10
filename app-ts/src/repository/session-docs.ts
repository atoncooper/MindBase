/** SessionDocumentRepository: documents uploaded within a conversation, parsed into chunks,
 * scoped strictly to the current session (retrieval never crosses sessions). */
export interface SessionDocumentMeta {
  id: string;
  sessionId: string;
  filename: string;
  sizeBytes: number;
  chunkCount: number;
  createdAt: number;
  /** 原始文件的 MinIO 对象(chat-files/*,可下载回看);空 = 未存(非 durable 存储/旧数据) */
  key?: string;
  contentType?: string;
}

export interface SessionDocHit {
  filename: string;
  text: string;
  score: number;
}

export interface SessionDocumentRepository {
  /** Persist a parsed document (text already split into chunks by the caller).
   * file = durable MinIO copy of the ORIGINAL binary (downloadable); absent for
   * non-durable storage or legacy rows. */
  save(
    sessionId: string,
    filename: string,
    chunks: string[],
    sizeBytes: number,
    file?: import("./persistence.js").StoredChatImage,
  ): Promise<SessionDocumentMeta>;
  list(sessionId: string): Promise<SessionDocumentMeta[]>;
  /** Retrieve chunks relevant to the query, scoped to this session only. */
  search(sessionId: string, query: string, limit?: number): Promise<SessionDocHit[]>;
  /** Remove one document; id must belong to sessionId. True when a doc was deleted. */
  delete(sessionId: string, id: string): Promise<boolean>;
  deleteBySession(sessionId: string): Promise<number>;
}
