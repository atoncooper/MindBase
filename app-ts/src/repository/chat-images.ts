import type { StoredChatImage } from "./persistence.js";

/**
 * Chat image attachment storage. put() accepts data URLs (the wire format the
 * frontend sends with the ask payload); display uses presigned GET URLs; model
 * context hydration reads objects back as data URLs (a remote LLM provider
 * cannot fetch a local MinIO).
 */
export interface ChatImageStorage {
  /** true = objects survive restarts (MinIO); false = memory fallback (the
   * message doc keeps inline data URLs instead of refs). */
  readonly durable: boolean;
  put(sessionId: string, dataUrl: string): Promise<StoredChatImage>;
  /** Store an ORIGINAL file (session document attachments, downloadable). */
  putFile(sessionId: string, filename: string, buffer: Buffer, contentType: string): Promise<StoredChatImage>;
  /** Fresh display URL; ttl default 7d (history is re-fetched on every load). */
  presignGet(key: string, ttlSeconds?: number): Promise<string>;
  /** Read back as a data URL for model context. */
  getDataUrl(key: string): Promise<string | undefined>;
  remove(key: string): Promise<void>;
}
