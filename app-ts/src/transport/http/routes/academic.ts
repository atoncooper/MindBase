import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AcademicError, type AcademicService } from "../../../services/research/academic.js";
import { DOCX_MIME } from "../../../doc-parser/docx.js";
import { MAX_DOCX_BYTES, type ManuscriptDocxService } from "../../../services/research/manuscript-docx.js";
import { ResearchApprovalError, type ResearchApprovalService } from "../../../services/research/research-approval.js";
import { describeValidationFailures, type ResearchValidationService } from "../../../services/research/research-validation.js";
import { ResearchAdvisorError, type ResearchAdvisorService } from "../../../services/research/research-advisor.js";
import type { ResearchNotificationService } from "../../../services/research/notifications.js";
import type { SubmissionPackageService } from "../../../services/research/submission-package.js";
import type { QuotaService } from "../../../services/quota.js";
import type { ResearchMetrics } from "../../../services/research/metrics.js";
import {
  ResearchStageGateError,
  type ResearchStageGateService,
} from "../../../services/research/research-stage-gates.js";
import type { DocumentVersionService } from "../../../services/research/document-versions.js";
import {
  REVIEW_RESPONSE_MAX_ITEMS,
  type ReviewResponseItem,
  type ReviewResponseService,
} from "../../../services/research/review-response.js";
import {
  RESEARCH_APPROVAL_SCOPES,
  type ResearchApproval,
  type ResearchApprovalScope,
} from "../../../repository/research-approvals.js";

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

/**
 * Explicit approval JSON (camelCase, approval v2 fields included). Listing the
 * fields keeps the REST contract stable and stops a Mongo `_id` from leaking.
 */
function serializeApproval(approval: ResearchApproval): Record<string, unknown> {
  return {
    id: approval.id,
    uid: approval.uid,
    projectId: approval.projectId,
    kind: approval.kind,
    status: approval.status,
    note: approval.note,
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    decisionNote: approval.decisionNote,
    scope: approval.scope,
    experimentId: approval.experimentId,
    expiresAt: approval.expiresAt,
    consumedAt: approval.consumedAt,
    payloadHash: approval.payloadHash,
    requestedBy: approval.requestedBy,
  };
}

/** 路径/查询里的历史版本号：必须是正整数，否则路由返回 422。 */
function parseVersion(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * POST review-response body 校验：items 必须是非空数组（最多 30 条），逐条含
 * comment 与 response。返回字符串表示校验失败（路由 422），否则返回归一化条目。
 */
function parseReviewItems(raw: unknown): ReviewResponseItem[] | string {
  if (!Array.isArray(raw)) return "items 必须是数组（每项含 comment 与 response，change 可选）";
  if (raw.length === 0) return "items 不能为空";
  if (raw.length > REVIEW_RESPONSE_MAX_ITEMS) return "审稿意见最多 " + REVIEW_RESPONSE_MAX_ITEMS + " 条";
  const items: ReviewResponseItem[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const row = raw[index] as Record<string, unknown> | null | undefined;
    if (!row || typeof row !== "object" || Array.isArray(row)) return "items[" + index + "] 必须是对象";
    const comment = typeof row.comment === "string" ? row.comment.trim() : "";
    if (comment === "") return "items[" + index + "].comment 不能为空";
    const response = typeof row.response === "string" ? row.response.trim() : "";
    if (response === "") return "items[" + index + "].response 不能为空";
    const change = typeof row.change === "string" ? row.change.trim() : "";
    items.push({ comment, response, ...(change !== "" ? { change } : {}) });
  }
  return items;
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
    /** Optional integrity gate for the submission endpoint (validation must pass). */
    validation?: Pick<ResearchValidationService, "validate">;
    /** Optional deterministic next-action advisor . */
    advisor?: ResearchAdvisorService;
    /** Optional in-app notification sink; absent = no bell entries. */
    notifications?: ResearchNotificationService;
    /** Optional submission package builder (zip). */
    submissionPackage?: SubmissionPackageService;
    /** Optional member quota for research exports/analysis. */
    quota?: Pick<QuotaService, "consumeKind">;
    /** Optional in-process research metrics. */
    metrics?: ResearchMetrics;
    /** Optional stage-gate/autoMode service; absent = /gates 503. */
    gates?: ResearchStageGateService;
    /** 文档版本历史；absent = versions/diff/restore 端点 503。 */
    versions?: DocumentVersionService;
    /** 审稿回复信生成；absent = review-response 端点 503。 */
    reviewResponse?: ReviewResponseService;
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

  /** 导出配额；未启用/存储不可用时放行。 */
  const consumeExport = async (uid: string): Promise<boolean> =>
    !deps.quota || (await deps.quota.consumeKind(uid, "academic_export"));

  /** If-Match：接受裸毫秒时间戳、引号形式或 W/ 前缀；缺省表示不做前置条件。 */
  const expectedUpdatedAt = (req: FastifyRequest): number | undefined => {
    const raw = req.headers["if-match"];
    if (typeof raw !== "string") return undefined;
    const match = raw.match(/(\d{10,})/);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };

  /**
   * Maps a domain error onto its HTTP status; anything else is rethrown to the
   * global 500 handler. AcademicError and ResearchStageGateError both carry the
   * status, so the two never drift into different response shapes.
   */
  const mapError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof AcademicError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    if (err instanceof ResearchStageGateError) {
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

  /**
   * Approval domain errors are state conflicts, not server faults: an expired or
   * already-consumed decision maps to 409 (retry after a new request), a missing
   * one to 404, and anything else approval-related to 422 — always `{ detail }`.
   */
  const mapApprovalError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof ResearchApprovalError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "not_pending" || err.code === "expired" || err.code === "consumed"
            ? 409
            : 422;
      return reply.status(status).send({ detail: err.message });
    }
    throw err;
  };

  const runApprovals = async <T>(
    reply: FastifyReply,
    handler: () => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await handler();
    } catch (err) {
      return mapApprovalError(reply, err);
    }
  };

  // ---- projects -----------------------------------------------------------

  app.get("/academic/projects", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    return run(reply, () => deps.academic.listProjects(uid, req.query));
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
    return run(reply, () =>
      deps.academic.updateProject(uid, projectId, req.body, expectedUpdatedAt(req)),
    );
  });

  // 软删除：移入回收站（默认列表不再返回）。
  app.delete("/academic/projects/:projectId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.deleteProject(uid, projectId));
  });

  app.post("/academic/projects/:projectId/restore", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.restoreProject(uid, projectId));
  });

  // 永久删除：级联清理文献/稿件/事件/审批/实验等子数据。
  app.delete("/academic/projects/:projectId/purge", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.purgeProject(uid, projectId));
  });

  // ---- stage gates + controlled automation ---------------
  // GET is read-only (evaluate only); POST syncs autoRule plan tasks and may
  // advance one stage when project.autoMode="auto". Neither endpoint can ever
  // write an "approved" stage status.
  app.get("/academic/projects/:projectId/gates", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.gates) return reply.code(503).send({ detail: "阶段门禁服务未启用" });
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.gates!.evaluate(uid, projectId));
  });

  app.get("/academic/projects/:projectId/next-actions", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.advisor) return reply.code(503).send({ detail: "研究顾问未启用" });
    const { projectId } = req.params as { projectId: string };
    try {
      return await deps.advisor.suggest(uid, projectId);
    } catch (err) {
      if (err instanceof ResearchAdvisorError) return reply.status(err.status).send({ detail: err.message });
      throw err;
    }
  });

  app.post("/academic/projects/:projectId/gates/sync", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.gates) return reply.code(503).send({ detail: "阶段门禁服务未启用" });
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.gates!.apply(uid, projectId));
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

  app.patch("/academic/projects/:projectId/literature/:ref", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, ref } = req.params as { projectId: string; ref: string };
    return run(reply, () => deps.academic.updateLiterature(uid, projectId, decodeURIComponent(ref), req.body));
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
    return run(reply, () => deps.academic.saveSection(uid, documentId, req.body, expectedUpdatedAt(req)));
  });

  app.delete("/academic/documents/:documentId/sections/:sectionKey", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId, sectionKey } = req.params as { documentId: string; sectionKey: string };
    return run(reply, () => deps.academic.deleteSection(uid, documentId, decodeURIComponent(sectionKey)));
  });

  // ---- document versions + review-response letter -------------------------

  app.get("/academic/documents/:documentId/versions", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.versions) return reply.code(503).send({ detail: "文档版本服务未启用" });
    const versions = deps.versions;
    const { documentId } = req.params as { documentId: string };
    return run(reply, async () => {
      const { document } = await deps.academic.getDocument(uid, documentId);
      return {
        documentId,
        title: document.title,
        versions: await versions.list(uid, document.projectId, documentId),
      };
    });
  });

  app.get("/academic/documents/:documentId/versions/:version/diff", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.versions) return reply.code(503).send({ detail: "文档版本服务未启用" });
    const versions = deps.versions;
    const { documentId, version: versionParam } = req.params as { documentId: string; version: string };
    const fromVersion = parseVersion(versionParam);
    if (fromVersion === undefined) return reply.code(422).send({ detail: "version 必须是正整数" });
    const query = (req.query ?? {}) as { to?: unknown };
    let toVersion: number | undefined;
    if (query.to !== undefined && query.to !== "") {
      toVersion = parseVersion(query.to);
      if (toVersion === undefined) return reply.code(422).send({ detail: "to 必须是正整数" });
    }
    return run(reply, async () => {
      const { document } = await deps.academic.getDocument(uid, documentId);
      return versions.diff(uid, document.projectId, documentId, fromVersion, toVersion);
    });
  });

  app.post("/academic/documents/:documentId/versions/:version/restore", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.versions) return reply.code(503).send({ detail: "文档版本服务未启用" });
    const versions = deps.versions;
    const { documentId, version: versionParam } = req.params as { documentId: string; version: string };
    const version = parseVersion(versionParam);
    if (version === undefined) return reply.code(422).send({ detail: "version 必须是正整数" });
    return run(reply, async () => {
      const { document } = await deps.academic.getDocument(uid, documentId);
      return versions.restore(uid, document.projectId, documentId, version);
    });
  });

  app.post("/academic/documents/:documentId/review-response", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.reviewResponse) return reply.code(503).send({ detail: "审稿回复信服务未启用" });
    const reviewResponse = deps.reviewResponse;
    const { documentId } = req.params as { documentId: string };
    const body = (req.body ?? {}) as { items?: unknown; title?: unknown };
    const items = parseReviewItems(body.items);
    if (typeof items === "string") return reply.code(422).send({ detail: items });
    const title = typeof body.title === "string" ? body.title.trim() : "";
    return run(reply, async () => {
      const { document } = await deps.academic.getDocument(uid, documentId);
      const created = await reviewResponse.create(uid, document.projectId, {
        documentTitle: title || document.title,
        items,
        actor: "user",
      });
      return { document: created.document, letter: { title: created.letter.title } };
    });
  });

  // ---- human approval gates ------------------------------------------------
  app.get("/academic/projects/:projectId/approvals", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { projectId } = req.params as { projectId: string };
    return runApprovals(reply, async () =>
      (await deps.approvals!.list(uid, projectId)).map(serializeApproval),
    );
  });

  app.post("/academic/projects/:projectId/approvals", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as {
      kind?: unknown;
      note?: unknown;
      scope?: unknown;
      experimentId?: unknown;
      ttlMs?: unknown;
    };
    if (body.kind !== "experiment" && body.kind !== "submission") {
      return reply.code(422).send({ detail: "kind 必须是 experiment 或 submission" });
    }
    const kind = body.kind as "experiment" | "submission";
    let scope: ResearchApprovalScope | undefined;
    if (body.scope !== undefined) {
      if (
        typeof body.scope !== "string" ||
        !(RESEARCH_APPROVAL_SCOPES as readonly string[]).includes(body.scope)
      ) {
        return reply.code(422).send({ detail: "scope 必须是 experiment/submission/export" });
      }
      scope = body.scope as ResearchApprovalScope;
    }
    let experimentId: string | undefined;
    if (body.experimentId !== undefined) {
      if (typeof body.experimentId !== "string" || body.experimentId.trim() === "") {
        return reply.code(422).send({ detail: "experimentId 必须是非空字符串" });
      }
      experimentId = body.experimentId.trim();
    }
    let ttlMs: number | undefined;
    if (body.ttlMs !== undefined) {
      if (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
        return reply.code(422).send({ detail: "ttlMs 必须是正数（毫秒）" });
      }
      ttlMs = Math.floor(body.ttlMs);
    }
    const note = typeof body.note === "string" ? body.note : undefined;
    const approval = await deps.approvals!.request(uid, projectId, kind, note, {
      requestedBy: "user",
      ...(scope !== undefined ? { scope } : {}),
      ...(experimentId !== undefined ? { experimentId } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }).catch((err: unknown) => {
      if (err instanceof ResearchApprovalError) return err;
      throw err;
    });
    if (approval instanceof ResearchApprovalError) return mapApprovalError(reply, approval);
    void deps.notifications?.create({
      uid,
      projectId,
      type: "approval",
      title: "待审批：" + (kind === "experiment" ? "实验执行" : "论文提交"),
      ...(note ? { body: note } : {}),
      link: "/research?project=" + encodeURIComponent(projectId) + "&tab=approvals",
    });
    return serializeApproval(approval);
  });

  app.post("/academic/approvals/:approvalId/decision", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
    const { approvalId } = req.params as { approvalId: string };
    const body = (req.body ?? {}) as { approved?: unknown; note?: unknown };
    if (typeof body.approved !== "boolean") {
      return reply.code(422).send({ detail: "approved 必须是 boolean" });
    }
    const note = typeof body.note === "string" ? body.note : undefined;
    return runApprovals(reply, async () => {
      const approval = await deps.approvals!.decide(uid, approvalId, body.approved as boolean, note);
      void deps.notifications?.create({
        uid,
        projectId: approval.projectId,
        type: "approval",
        title: body.approved ? "审批已通过：" + (approval.kind === "experiment" ? "实验执行" : "论文提交") : "审批被拒绝",
        link: "/research?project=" + encodeURIComponent(approval.projectId) + "&tab=approvals",
      });
      return serializeApproval(approval);
    });
  });

  app.get("/academic/documents/:documentId/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { documentId } = req.params as { documentId: string };
    const query = req.query as { format?: string; force?: string };
    if (!(await consumeExport(uid))) return reply.status(429).send({ detail: "今日导出次数已用完，请明天再试或升级会员。" });
    deps.metrics?.inc("export_text");
    return run(reply, () =>
      deps.academic.exportDocument(uid, documentId, query.format, {
        force: query.force === "true" || query.force === "1",
      }),
    );
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
      const query = req.query as { force?: string };
      if (!(await consumeExport(uid))) return reply.status(429).send({ detail: "今日导出次数已用完，请明天再试或升级会员。" });
      deps.metrics?.inc("export_docx");
      try {
        const result = await manuscriptDocx.exportDocxBuffer(uid, documentId, {
          force: query.force === "true" || query.force === "1",
        });
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
      const query = req.query as { force?: string };
      const body = (req.body ?? {}) as { force?: unknown };
      const force = body.force === true || query.force === "true" || query.force === "1";
      if (!(await consumeExport(uid))) return reply.status(429).send({ detail: "今日导出次数已用完，请明天再试或升级会员。" });
      deps.metrics?.inc("export_docx");
      return run(reply, () => manuscriptDocx.exportDocxToCloud(uid, documentId, { force }));
    });

    // 2.3b Submission gate: validation must pass AND a one-shot submission approval
    // must be consumed before the manuscript is exported for submission.
    app.post("/academic/documents/:documentId/submit", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      if (!deps.approvals) return reply.code(503).send({ detail: "审批服务未启用" });
      if (!(await consumeExport(uid))) return reply.status(429).send({ detail: "今日导出次数已用完，请明天再试或升级会员。" });
      const { documentId } = req.params as { documentId: string };
      deps.metrics?.inc("submission");
      try {
        const { document } = await deps.academic.getDocument(uid, documentId);
        if (deps.validation) {
          const report = await deps.validation.validate(uid, document.projectId, documentId);
          if (!report.pass) {
            return reply.status(409).send({
              detail:
                "提交被拒绝：学术校验未通过，未生成投稿文件。\n" +
                describeValidationFailures(report) +
                "\n请先修正以上问题，再发起提交审批。",
            });
          }
        }
        let approval;
        try {
          approval = await deps.approvals.consume(uid, document.projectId, "submission");
        } catch (err) {
          return mapApprovalError(reply, err);
        }
        const saved = await manuscriptDocx.exportDocxToCloud(uid, documentId, { force: false });
        await deps.academic.recordSubmission(uid, document.projectId, documentId, saved.fileName, approval.id);
        return { submitted: true, documentId, approvalId: approval.id, file: saved };
      } catch (err) {
        return mapError(reply, err);
      }
    });

    // 2.3c Submission package: validation + submission approval + zip bundle.
    app.get("/academic/documents/:documentId/package", async (req, reply) => {
      const uid = requireUid(reply);
      if (!uid) return reply;
      if (!deps.submissionPackage) return reply.code(503).send({ detail: "投稿包服务未启用" });
      if (!(await consumeExport(uid))) return reply.status(429).send({ detail: "今日导出次数已用完，请明天再试或升级会员。" });
      const { documentId } = req.params as { documentId: string };
      deps.metrics?.inc("package");
      try {
        const result = await deps.submissionPackage.build(uid, documentId);
        const fileName = encodeURIComponent(result.fileName).replace(/'/g, "%27");
        return reply
          .header("Content-Disposition", "attachment; filename*=UTF-8''" + fileName)
          .type("application/zip")
          .send(result.bytes);
      } catch (err) {
        if (err instanceof AcademicError) return mapError(reply, err);
        if (err instanceof ResearchApprovalError) return mapApprovalError(reply, err);
        throw err;
      }
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

  // ---- project backup (audit export) --------------------------------------
  app.get("/academic/projects/:projectId/export", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    let payload: Awaited<ReturnType<AcademicService["exportProject"]>>;
    try {
      payload = await deps.academic.exportProject(uid, projectId);
    } catch (err) {
      return mapError(reply, err);
    }
    deps.metrics?.inc("project_export");
    const fileName = encodeURIComponent("project-" + projectId + ".json").replace(/'/g, "%27");
    return reply
      .header("Content-Disposition", "attachment; filename*=UTF-8''" + fileName)
      .type("application/json")
      .send(JSON.stringify(payload, null, 2));
  });

  // ---- events -------------------------------------------------------------

  app.get("/academic/projects/:projectId/events", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, () => deps.academic.listEvents(uid, projectId, req.query));
  });

  // SSE 事件流：轮询事件表并在有新事件时推送；前端可用 EventSource 订阅。
  app.get("/academic/projects/:projectId/events/stream", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sent = new Set<string>();
    let closed = false;
    const send = (event: { id: string }) => {
      if (sent.has(event.id)) return;
      sent.add(event.id);
      if (sent.size > 500) sent.delete(sent.values().next().value as string);
      res.write("id: " + event.id + "\ndata: " + JSON.stringify(event) + "\n\n");
    };
    const poll = async () => {
      if (closed) return;
      try {
        const { events } = await deps.academic.listEvents(uid, projectId, { limit: 20 });
        for (const event of [...events].reverse()) send(event);
      } catch {
        // 单次轮询失败不结束流
      }
    };
    deps.metrics?.inc("events_stream_open");
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, 15_000);
    req.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      res.end();
    });
    return reply;
  });
}
