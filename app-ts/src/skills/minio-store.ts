import { Client } from "minio";
import { Readable } from "node:stream";
import { config } from "../config/index.js";
import type { SkillZipStore } from "./manager.js";

/**
 * MinIO-backed skill zip store (skills/{uid}/{skill_id}.zip in the shared
 * bucket). Returns null when no endpoint is configured — the skills
 * subsystem degrades to disabled.
 */
export function createSkillZipStore(): SkillZipStore | null {
  const endpoint = config.minio.endpoint;
  if (!endpoint) return null;
  const clean = endpoint.replace(/^https?:\/\//, "");
  const secure = config.minio.secure || endpoint.startsWith("https://");
  // minio-js contract: endPoint is host ONLY (no scheme, no port) — the port
  // is a separate field. Passing "minio:9000" as endPoint throws
  // InvalidEndPointError.
  const host = clean.split(":")[0];
  const port = clean.includes(":") ? Number(clean.split(":")[1]) : undefined;
  const client = new Client({
    endPoint: host,
    port,
    useSSL: secure,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
  const bucket = config.minio.bucket;

  return {
    async put(key, data, contentType) {
      await client.putObject(bucket, key, Readable.from(data), data.length, { contentType });
    },
    async get(key) {
      const stream = await client.getObject(bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return Buffer.concat(chunks);
    },
    async remove(key) {
      await client.removeObject(bucket, key);
    },
  };
}
