import type { FastifyInstance, FastifyReply } from "fastify";

import { getRequestContext } from "../../../context/request-context.js";
import { createLogger } from "../../../logger.js";
import type { OfficeDocumentService } from "../../../services/office-review.js";

const log = createLogger("HTTP");

const UPLOAD_UUID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_NAME_CHARS = 200;

/**
 * /chat/office/document — structured Word preview of one of the user's own
 * cloud files.
 *
 * The web client renders the returned blocks as a document page (real
 * typography, no screenshots); this is the cloud-detail counterpart of the
 * chat's office-document artifact. Identity comes from the gateway-injected
 * X-Uid, so the route can only read the caller's own files.
 *
 * Status mapping: 401 no identity, 400 bad uuid, 404 foreign/missing file,
 * 503 cloud/render unavailable, 200 { available:false } for a clean degradation
 * (e.g. a non-docx file) that the UI shows as a hint.
 */
export function registerOfficeDocumentRoutes(
  app: FastifyInstance,
  deps: { documents?: OfficeDocumentService },
): void {
  app.get("/chat/office/document", async (req, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    if (!uid) return reply.status(401).send({ detail: "未登录" });

    const query = req.query as { upload_uuid?: unknown; name?: unknown };
    const uploadUuid = typeof query.upload_uuid === "string" ? query.upload_uuid.trim() : "";
    if (!UPLOAD_UUID_RE.test(uploadUuid)) {
      return reply.status(400).send({ detail: "upload_uuid 不合法" });
    }
    const name =
      typeof query.name === "string" && query.name.trim() !== ""
        ? query.name.trim().slice(0, MAX_NAME_CHARS)
        : undefined;

    if (!deps.documents) {
      return reply.status(503).send({ detail: "Office 预览服务未启用" });
    }
    try {
      const result = await deps.documents.documentPreview(uid, uploadUuid, name ? { name } : {});
      if (!result.available) {
        return reply.status(result.status ?? 200).send({ available: false, detail: result.detail });
      }
      return reply.send({ available: true, data: result.data });
    } catch (err) {
      log.error(
        "[OFFICE-DOCUMENT] route failed uid=%s uuid=%s: %s",
        uid,
        uploadUuid,
        err instanceof Error ? err.message : String(err),
      );
      return reply.status(500).send({ detail: "文档预览失败，请稍后重试" });
    }
  });
}
