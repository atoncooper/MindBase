import { randomUUID } from "node:crypto";
import { Client } from "minio";
import { config } from "../../config/index.js";
import type { StoredChatImage } from "../persistence.js";
import type { ChatImageStorage } from "../chat-images.js";

const DEFAULT_PRESIGN_TTL = 7 * 24 * 3600;
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

// minio-js contract: endPoint is host ONLY (no scheme, no port) — the port is a
// separate field. Passing "minio:9000" as endPoint throws InvalidEndPointError.
function buildClient(endpoint: string): Client {
  const clean = endpoint.replace(/^https?:\/\//, "");
  const secure = config.minio.secure || endpoint.startsWith("https://");
  return new Client({
    endPoint: clean.split(":")[0],
    port: clean.includes(":") ? Number(clean.split(":")[1]) : undefined,
    useSSL: secure,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    // pin the region: presignedGetObject otherwise performs a bucket-region
    // lookup over the network — which would dial the (browser-only) public
    // endpoint from inside the container and ECONNREFUSED.
    region: "us-east-1",
  });
}

function parseDataUrl(dataUrl: string): { contentType: string; buffer: Buffer } | undefined {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return undefined;
  return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
}

/**
 * MinIO-backed chat image store (chat-images/{sessionId}/{uuid}.{ext} in the
 * shared bucket). I/O goes through the internal endpoint. Display URLs are
 * presigned for the internal host (minio:9000) and then rewritten to the nginx
 * /minio-proxy/ passthrough — nginx rewrites Host back to minio:9000, so the
 * SigV4 signature stays valid while the S3 API port stays unpublished.
 * `minio.publicEndpoint` prefixes the proxy path (empty = same-origin relative).
 * null = MinIO not configured → callers keep inline data URLs.
 */
export function createMinioChatImageStorage(): ChatImageStorage | null {
  const endpoint = config.minio.endpoint;
  if (!endpoint) return null;
  const io = buildClient(endpoint);
  const bucket = config.minio.bucket;
  const proxyBase = (config.minio.publicEndpoint || "").replace(/\/$/, "");

  return {
    durable: true,

    async put(sessionId: string, dataUrl: string): Promise<StoredChatImage> {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) throw new Error("无效的图片 data URL");
      const ext = EXT_BY_MIME[parsed.contentType] ?? "png";
      const key = `chat-images/${sessionId}/${randomUUID()}.${ext}`;
      await io.putObject(bucket, key, parsed.buffer, parsed.buffer.length, { contentType: parsed.contentType });
      return { key, contentType: parsed.contentType, sizeBytes: parsed.buffer.length };
    },

    async putFile(sessionId: string, filename: string, buffer: Buffer, contentType: string): Promise<StoredChatImage> {
      const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase().slice(0, 8) : "bin";
      // uuid 名防路径/编码问题;展示名始终以 Mongo meta 为准
      const key = `chat-files/${sessionId}/${randomUUID()}.${ext}`;
      await io.putObject(bucket, key, buffer, buffer.length, { contentType });
      return { key, contentType, sizeBytes: buffer.length };
    },

    async remove(key: string): Promise<void> {
      await io.removeObject(bucket, key);
    },

    async presignGet(key: string, ttlSeconds = DEFAULT_PRESIGN_TTL): Promise<string> {
      const url = await io.presignedGetObject(bucket, key, ttlSeconds);
      // http://minio:9000/{bucket}/{key}?X-Amz... → /minio-proxy/{bucket}/{key}?X-Amz...
      const query = url.slice(url.indexOf("?"));
      return `${proxyBase}/minio-proxy/${bucket}/${key}${query}`;
    },

    async getDataUrl(key: string): Promise<string | undefined> {
      const ext = key.split(".").pop() ?? "png";
      const contentType = MIME_BY_EXT[ext] ?? "image/png";
      const stream = await io.getObject(bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`;
    },
  };
}
