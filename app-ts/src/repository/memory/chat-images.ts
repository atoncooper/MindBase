import type { StoredChatImage } from "../persistence.js";
import type { ChatImageStorage } from "../chat-images.js";

/**
 * Non-durable in-process fallback (MinIO unconfigured or unusable): objects live
 * only for this process lifetime, so the message doc keeps inline data URLs and
 * presignGet simply returns them.
 */
export function createMemoryChatImageStorage(): ChatImageStorage {
  const objects = new Map<string, { dataUrl: string; contentType: string; sizeBytes: number }>();
  let seq = 0;

  return {
    durable: false,

    async put(_sessionId: string, dataUrl: string): Promise<StoredChatImage> {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(dataUrl);
      const contentType = m?.[1] ?? "image/png";
      const key = `memory/chat-images/${++seq}`;
      objects.set(key, { dataUrl, contentType, sizeBytes: dataUrl.length });
      return { key, contentType, sizeBytes: dataUrl.length };
    },

    async putFile(sessionId: string, filename: string, buffer: Buffer, contentType: string): Promise<StoredChatImage> {
      const key = `memory/chat-files/${++seq}`;
      objects.set(key, {
        dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
        contentType,
        sizeBytes: buffer.length,
      });
      return { key, contentType, sizeBytes: buffer.length };
    },

    async remove(key: string): Promise<void> {
      objects.delete(key);
    },

    async presignGet(key: string): Promise<string> {
      return objects.get(key)?.dataUrl ?? "";
    },

    async getDataUrl(key: string): Promise<string | undefined> {
      return objects.get(key)?.dataUrl;
    },
  };
}
