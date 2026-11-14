import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AcademicError, type AcademicService } from "../../../services/academic.js";
import { DOCX_MIME } from "../../../doc-parser/docx.js";
import { MAX_DOCX_BYTES, type ManuscriptDocxService } from "../../../services/manuscript-docx.js";
import type { ResearchApprovalService } from "../../../services/research-approval.js";

/** One uploaded .docx from a multipart request. */
interface DocxUpload {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  title?: string;
  kind?: string;
}

/** Raised when the multipart file exceeds MAX_DOCX_BYTES (mapped to 422, per contract §2.1). */
class DocxTooLargeError extends Error {}

/**
 * Reads the multipart body of the Word import endpoint: the file rides the
 * `file` field, `title`/`kind` are optional text fields. req.parts() (rather
 * than req.file()) is used so those optional fields are accepted before *or*
 * after the file, which is what browser FormData and API clients actually send.
 */
async function readDocxUpload(req: FastifyRequest): Promise<DocxUpload | undefined> {
  const parts = req.parts({ limits: { fileSize: MAX_DOCX_BYTES } });
  const fields = new Map<string, string>();
  let file: { fileName: string; mimeType: string; bytes: Buffer } | undefined;
  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname !== "file") {
        await part.toBuffer();
        continue;
      }
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw new DocxTooLargeError();
      if (file === undefined) {
        file = { fileName: part.filename ?? "", mimeType: part.mimetype ?? "", bytes };
      }
      continue;
    }
    if (typeof part.value === "string") fields.set(part.fieldname, part.value);
    else if (Buffer.isBuffer(part.value)) fields.set(part.fieldname, part.value.toString("utf8"));
  }
  if (!file) return undefined;
  const title = fields.get("title")?.trim();
  const kind = fields.get("kind")?.trim();
  return {
    ...file,
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** RFC 5987 attachment header; the title is UTF-8 percent-encoded so Chinese file names work. */
function docxContentDisposition(title: string): string {
  const fileName = encodeURIComponent((title.trim() || "manuscript") + ".docx").replace(/'/g, "%27");
  return "attachment; filename*=UTF-8''" + fileName;
}

/** Multipart size-limit failures (busboy/@fastify/multipart) map to 422, per contract §2.1. */
function isMultipartTooLarge(err: unknown): boolean {
  if (err instanceof DocxTooLargeError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT";
}

/**
 * /academic/* — 科研工作台 REST surface.
 *
 * Route layer only: uid from the gateway (X-Uid → request context), camelCase
 * JSON bodies passed to AcademicService, domain errors mapped to
 * { status, detail }. Ownership/validation live in the service.
 *
 * Word (.docx) endpoints (contract: docs/manuscript-docx.md §2): import an
 * existing manuscript, download the document as .docx and save it back to the
 * project cloud drive. They are registered only when the composition root
 * injected ManuscriptDocxService (cloud drive assembled), so an academic-only
 * boot keeps the previous surface.
 */
export function registerAcademicRoutes(
  app: FastifyInstance,
  deps: {
    academic: AcademicService;
    approvals?: ResearchApprovalService;
    /** Word import/export; absent (cloud drive unassembled) = /export/docx routes not registered */
    manuscriptDocx?: ManuscriptDocxService;
  },
): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  /** Maps an AcademicError onto its HTTP status; anything else is rethrown to the global 500 handler. */
  const mapError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof AcademicError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  /** Runs a handler, mapping AcademicError onto its HTTP status and everything else to a 500. */
  const run = async <T>(reply: FastifyReply, handler: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await handler();
    } catch (err) {
      return mapError(reply, err);
    }
  };

  // ---- projects -----------------------------------------------------------

  app.get("/academic/projects", async (_req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.listProjects(uid));
  });

  app.post("/academic/projects", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.createProject(uid, req.body));
  });

  app.get("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.getProject(uid, projectId));
  });

  app.patch("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.updateProject(uid, projectId, req.body));
  });

  app.delete("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.deleteProject(uid, projectId));
  });

  // ---- literature ---------------------------------------------------------

  app.get("/academic/projects/:projectId/literature", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listLiterature(uid, projectId, req.query));
  });

  app.post("/academic/projects/:projectId/literature", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.addLiterature(uid, projectId, req.body));
  });

  app.get("/academic/projects/:projectId/literature/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.exportBibtex(uid, projectId));
  });

  app.post("/academic/projects/:projectId/literature/:ref/verify", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, ref } = req.params as { projectId: string; ref: string };
    return run(reply, () => deps.academic.verifyLiterature(uid, projectId, decodeURIComponent(ref)));
  });

  app.delete("/academic/projects/:projectId/literature/:ref", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, ref } = req.params as { projectId: string; ref: string };
    return run(reply, () => deps.academic.removeLiterature(uid, projectId, decodeURIComponent(ref)));
  });

  app.get("/academic/literature/search", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.searchLiterature(uid, req.query));
  });

  // ---- documents ----------------------------------------------------------

  app.get("/academic/projects/:projectId/documents", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listDocuments(uid, projectId));
  });

  app.post("/academic/projects/:projectId/documents", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.createDocument(uid, projectId, req.body));
  });

  app.get("/academic/documents/:documentId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    return run(reply, () => deps.academic.getDocument(uid, documentId));
  });

  app.post("/academic/documents/:documentId/sections", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    return run(reply, () => deps.academic.saveSection(uid, documentId, req.body));
  });

  app.delete("/academic/documents/:documentId/sections/:sectionKey", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId, sectionKey } = req.params as { documentId: string; sectionKey: string };
    return run(reply, () => deps.academic.deleteSection(uid, documentId, decodeURIComponent(sectionKey)));
  });

  // ---- human approval gates ------------------------------------------------
  app.get("/academic/projects/:projectId/approvals", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.approvals!.list(uid, projectId));
  });

  app.post("/academic/projects/:projectId/approvals", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { projectId } = req.params as { projectId: string };
    const body = req.body as { kind?: string; note?: string };
    if (body.kind !== "experiment" && body.kind !== "submission") {
      return reply.code(422).send({ detail: "kind 必须是 experiment 或 submission" });
    }
    const kind = body.kind as "experiment" | "submission";
    return run(reply, () => deps.approvals!.request(uid, projectId, kind, body.note));
  });

  app.post("/academic/approvals/:approvalId/decision", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { approvalId } = req.params as { approvalId: string };
    const body = req.body as { approved?: boolean; note?: string };
    if (typeof body.approved !== "boolean") {
      return reply.code(422).send({ detail: "approved 必须是 boolean" });
    }
    return run(reply, () => deps.approvals!.decide(uid, approvalId, body.approved!, body.note));
  });

  app.get("/academic/documents/:documentId/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    const query = req.query as { format?: string };
    return run(reply, () => deps.academic.exportDocument(uid, documentId, query.format));
  });

  // ---- Word import / export (docs/manuscript-docx.md §2.1-§2.3) + project
  // ---- file list (docs/project-files.md §1) --------------------------------
  // Registered only when the composition root assembled the cloud-drive-backed
  // manuscript service; an academic-only boot keeps the previous surface.
  if (deps.manuscriptDocx) {
    const manuscriptDocx = deps.manuscriptDocx;

    // 2.1 Import an existing Word manuscript: multipart (file, optional title/kind).
    app.post("/academic/projects/:projectId/documents/import", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      const { projectId } = req.params as { projectId: string };
      let upload: DocxUpload | undefined;
      try {
        upload = await readDocxUpload(req);
      } catch (err) {
        if (isMultipartTooLarge(err)) return reply.status(422).send({ detail: "Word 文件过大（上限 20MB）" });
        throw err;
      }
      if (!upload) return reply.status(400).send({ detail: "缺少文件（multipart 字段名 file）" });
      const file = upload;
      if (file.bytes.byteLength > MAX_DOCX_BYTES) {
        return reply.status(422).send({ detail: "Word 文件过大（上限 20MB）" });
      }
      return run(reply, () =>
        manuscriptDocx.importDocx(uid, projectId, {
          fileName: file.fileName,
          mimeType: file.mimeType,
          bytes: file.bytes,
          ...(file.title !== undefined ? { title: file.title } : {}),
          ...(file.kind !== undefined ? { kind: file.kind } : {}),
        }),
      );
    });

    // 2.2 Export as a downloadable .docx (binary, no cloud write).
    app.get("/academic/documents/:documentId/export/docx", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      const { documentId } = req.params as { documentId: string };
      try {
        const result = await manuscriptDocx.exportDocxBuffer(uid, documentId);
        return reply
          .header("Content-Disposition", docxContentDisposition(result.title))
          .type(DOCX_MIME)
          .send(result.buffer);
      } catch (err) {
        return mapError(reply, err);
      }
    });

    // 2.3 Render + save back into the project cloud drive (05_论文) and record lastExport.
    app.post("/academic/documents/:documentId/export/docx", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      const { documentId } = req.params as { documentId: string };
      return run(reply, () => manuscriptDocx.exportDocxToCloud(uid, documentId));
    });

    // 2.4 Aggregated project file list (contract: docs/project-files.md §1):
    // the seven workspace folders plus the manuscript document source/lastExport
    // entries. Registered with the Word surface because it is the same
    // cloud-drive-backed service; an academic-only boot keeps the old surface.
    app.get("/academic/projects/:projectId/files", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      const { projectId } = req.params as { projectId: string };
      return run(reply, () => manuscriptDocx.listProjectFiles(uid, projectId));
    });

    // 2.5 Import a .docx that already lives in the project cloud drive as a
    // manuscript document (no re-upload; that upload becomes the export template).
    app.post("/academic/projects/:projectId/documents/import-from-cloud", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      const { projectId } = req.params as { projectId: string };
      const body = (req.body ?? {}) as { uploadUuid?: unknown; title?: unknown; kind?: unknown };
      const uploadUuid = typeof body.uploadUuid === "string" ? body.uploadUuid.trim() : "";
      if (uploadUuid === "") {
        return reply.status(422).send({ detail: "缺少 uploadUuid（项目云盘文件 id）" });
      }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      return run(reply, () =>
        manuscriptDocx.importDocxFromCloud(uid, projectId, {
          uploadUuid,
          ...(title !== "" ? { title } : {}),
          ...(kind !== "" ? { kind } : {}),
        }),
      );
    });
  }

  // ---- events -------------------------------------------------------------

  app.get("/academic/projects/:projectId/events", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listEvents(uid, projectId, req.query));
  });
}
