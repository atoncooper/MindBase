import { OfficeExportError } from "./errors.js";
import { DocumentIRError, validateDocumentIR, type DocumentIR, type IRImage } from "./ir.js";
import { legacyBlocksToDocument } from "./legacy-ir.js";
import { renderDocument, type ImageBytes, type ImageResolver } from "./render-doc.js";
import { auditDocumentStructure, type StructuralAudit } from "./qa-structural.js";
import { resolveTemplate, type DocTemplateRegistry } from "./templates.js";
import { buildPptx } from "./pptx.js";
import { buildXlsx } from "./xlsx.js";
import { fileStamp, safeFileStem } from "./ooxml.js";
import { CloudFolderError, CloudFolderService } from "../cloud-folders.js";
import { createLogger } from "../../logger.js";
import { OFFICE_LIMITS, type OfficeExportSpec } from "./types.js";

/**
 * Office export facade: spec -> package bytes -> cloud-drive file.
 *
 * The builders are pure (bytes in, bytes out); this service owns everything that
 * needs the outside world: the output-size ceiling, the file name and the single
 * M2M upload to app-cloud (the only component holding MinIO credentials, and the
 * only place a user's file may live).
 *
 * Failure direction: a build error is "invalid" (the model can fix its input), an
 * upload error is "cloud_unavailable" (retrying the same spec is pointless until
 * the cloud is back). Both surface as readable Chinese text through the tool.
 */

export const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

/** Minimal cloud port: enough to upload, nothing else (tests use a fake). */
export interface OfficeCloudPort {
  readonly configured: boolean;
  uploadFile(
    uid: string,
    folderId: number,
    name: string,
    data: Uint8Array,
    mimeType?: string,
  ): Promise<{ upload_uuid: string; name: string; size: number }>;
  /** Optional: resolve IR image blocks from the user's own cloud drive. */
  downloadFile?(uid: string, uploadUuid: string): Promise<{ contentType: string; data: Uint8Array }>;
  /** Optional: overwrite an existing file (document revision, same upload_uuid). */
  replaceFile?(
    uid: string,
    uploadUuid: string,
    data: Uint8Array,
    mimeType?: string,
    name?: string,
  ): Promise<{ upload_uuid: string; name: string; size: number }>;
}

/** Optional template source (docx round-trip): downloads the user's own file. */
export interface OfficeTemplatePort {
  downloadFile(uid: string, uploadUuid: string): Promise<{ contentType: string; data: Uint8Array }>;
}

export interface OfficeExportServiceOptions {
  cloud: OfficeCloudPort;
  /**
   * Agent folder resolver (find-or-create). Required for the default destination;
   * without it every export must pass an explicit folderId.
   */
  folders?: CloudFolderService;
  /** Output ceiling in bytes (defaults to OFFICE_LIMITS.outputBytes). */
  maxBytes?: number;
  /** Product timezone for the file stamp. */
  timeZone?: string;
  /** Template registry with user/brand overrides (defaults to the built-in registry). */
  templates?: DocTemplateRegistry;

  now?: () => Date;
}

export interface OfficeExportResult {
  format: OfficeExportSpec["format"];
  fileName: string;
  uploadUuid: string;
  size: number;
  /** Cloud-drive folder the file was stored in. */
  folderId: number;
  /** Human-readable destination, e.g. "agent/2026Q3" (root when folderId was explicit). */
  folderLabel: string;

}

/** Strips the directory part a template download may report. */
function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

const log = createLogger("OFFICE-EXPORT");

export class OfficeExportService {
  constructor(private readonly options: OfficeExportServiceOptions) {}

  /** Renders the package only (no upload); used by tests and by export-as-download paths. */
  async build(spec: OfficeExportSpec, options: { template?: Uint8Array; uid?: string } = {}): Promise<Buffer> {
    const title = spec.title?.trim() ?? "";
    if (title === "") throw new OfficeExportError("invalid", "缺少文档标题 title");
    if (spec.format === "docx") {
      if (!spec.docx) throw new OfficeExportError("invalid", "format=docx 需要提供 docx.document 或 docx.blocks");
      const ir = this.toDocumentIR(title, spec);
      const template = resolveTemplate(
        {
          ...(spec.docx.template ? { requested: spec.docx.template } : {}),
          ...(spec.docx.layout ? { styleHint: spec.docx.layout } : {}),
          titleHint: title,
        },
        this.options.templates,
      );
      log.info(
        "[OFFICE-EXPORT] docx template=%s reason=%s sections=%d blocks=%d",
        template.template.id,
        template.reason,
        ir.sections.length,
        ir.sections.reduce((sum, section) => sum + section.blocks.length, 0),
      );
      const resolveImage = this.imageResolver(options.uid);
      try {
        const logo = await this.brandLogo(options.uid, template.template);
        return this.checkSize(
          await renderDocument({
            ir,
            template: template.template,
            ...(options.template ? { templatePackage: options.template } : {}),
            ...(resolveImage ? { resolveImage } : {}),
            ...(logo ? { logo } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof DocumentIRError) throw new OfficeExportError("invalid", err.message);
        throw err;
      }
    }
    if (spec.format === "xlsx") {
      if (!spec.xlsx) throw new OfficeExportError("invalid", "format=xlsx 需要提供 xlsx.sheets");
      return this.checkSize(await buildXlsx({ title, sheets: spec.xlsx.sheets, now: this.now() }));
    }
    if (!spec.pptx) throw new OfficeExportError("invalid", "format=pptx 需要提供 pptx.slides");
    return this.checkSize(
      await buildPptx({
        title,
        slides: spec.pptx.slides,
        ...(spec.pptx.footer ? { footer: spec.pptx.footer } : {}),
        now: this.now(),
      }),
    );
  }

  /**
   * Builds the package and stores it in the user's cloud drive.
   *
   * The file name is "<title>_<yyyyMMdd-HHmm>.<ext>" so repeated exports of the
   * same document never collide and stay sortable in the cloud drive listing.
   */
  async export(
    uid: string,
    spec: OfficeExportSpec,
    options: { template?: Uint8Array; templateName?: string } = {},
  ): Promise<OfficeExportResult> {
    if (!this.options.cloud.configured) {
      throw new OfficeExportError("cloud_unavailable", "云盘服务未配置，无法保存生成的文件");
    }
    const bytes = await this.build(spec, { ...(options.template ? { template: options.template } : {}), uid });
    if (spec.revisionOf) {
      return this.replaceExisting(uid, spec, bytes);
    }
    const destination = await this.resolveFolder(uid, spec);
    const folderId = destination.folderId;
    const stem = safeFileStem(spec.title);
    const fileName = stem + "_" + fileStamp(this.now(), this.options.timeZone ?? "Asia/Shanghai") + "." + spec.format;
    let uploaded: { upload_uuid: string; name: string; size: number };
    try {
      uploaded = await this.options.cloud.uploadFile(uid, folderId, fileName, bytes, OFFICE_MIME[spec.format]);
    } catch (err) {
      throw new OfficeExportError(
        "cloud_unavailable",
        "云盘保存失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }

    return {
      format: spec.format,
      fileName: uploaded.name || fileName,
      uploadUuid: uploaded.upload_uuid,
      size: uploaded.size || bytes.byteLength,
      folderId,
      folderLabel: destination.label,
    };
  }

  /**
   * Render-free self-check for a docx spec: IR + template structural audit
   * (hierarchy, captions, overflow risks, genre expectations, content quality).
   * Used by the export tool so the agent gets feedback without any Office binary.
   */
  structureAudit(spec: OfficeExportSpec): StructuralAudit | undefined {
    if (spec.format !== "docx" || !spec.docx) return undefined;
    try {
      const ir = this.toDocumentIR(spec.title?.trim() ?? "", spec);
      const resolved = resolveTemplate(
        {
          ...(spec.docx.template ? { requested: spec.docx.template } : {}),
          ...(spec.docx.layout ? { styleHint: spec.docx.layout } : {}),
          titleHint: spec.title,
        },
        this.options.templates,
      );
      return auditDocumentStructure(ir, resolved.template);
    } catch (err) {
      log.warn("[OFFICE-EXPORT] structure audit skipped: %s", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Overwrites an existing cloud file with a new revision (same upload_uuid), so
   * iterating on a generated document never creates a second file. Delegates to
   * app-cloud PUT /internal/cloud/files/:upload_uuid.
   */
  private async replaceExisting(uid: string, spec: OfficeExportSpec, bytes: Buffer): Promise<OfficeExportResult> {
    const replace = this.options.cloud.replaceFile;
    if (!replace) {
      throw new OfficeExportError(
        "cloud_unavailable",
        "当前云盘服务不支持文件版本覆盖（app-cloud 需升级到包含 PUT /internal/cloud/files/:upload_uuid 的版本）；可先删除旧文件再重新生成。",
      );
    }
    let updated: { upload_uuid: string; name: string; size: number };
    try {
      updated = await replace.call(this.options.cloud, uid, spec.revisionOf as string, bytes, OFFICE_MIME[spec.format]);
    } catch (err) {
      throw new OfficeExportError(
        "invalid",
        "更新已有文件失败：" + (err instanceof Error ? err.message : String(err)) +
          "。请确认 uploadUuid 属于你本人、且文件仍在云盘中；若不确定，重新生成一个新文件。",
      );
    }
    log.info("[OFFICE-EXPORT] revised uploadUuid=%s size=%d", updated.upload_uuid, updated.size);
    return {
      format: spec.format,
      fileName: updated.name,
      uploadUuid: updated.upload_uuid,
      size: updated.size || bytes.byteLength,
      folderId: 0,
      folderLabel: "原文件位置（版本覆盖）",
    };
  }

  /** Builds the Document IR: explicit IR wins, legacy blocks are converted. */
  private toDocumentIR(title: string, spec: OfficeExportSpec): DocumentIR {
    if (spec.docx?.document) {
      try {
        return validateDocumentIR(spec.docx.document);
      } catch (err) {
        if (err instanceof DocumentIRError) throw new OfficeExportError("invalid", err.message);
        throw err;
      }
    }
    return legacyBlocksToDocument({
      title,
      blocks: spec.docx?.blocks ?? [],
      ...(spec.docx?.template ? { template: spec.docx.template } : {}),
      ...(spec.docx?.layout ? { layout: spec.docx.layout } : {}),
    });
  }

  /** Downloads the template brand logo (best effort; a missing logo never fails the export). */
  private async brandLogo(
    uid: string | undefined,
    template: { brand?: { logoUploadUuid?: string } },
  ): Promise<ImageBytes | undefined> {
    const uploadUuid = template.brand?.logoUploadUuid;
    const download = this.options.cloud.downloadFile;
    if (!uid || !uploadUuid || !download) return undefined;
    try {
      const file = await download.call(this.options.cloud, uid, uploadUuid);
      if (!file.data || file.data.byteLength === 0) return undefined;
      return { data: file.data, mime: file.contentType || "image/png" };
    } catch (err) {
      log.warn("[OFFICE-EXPORT] brand logo download failed: %s", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /** Cloud-backed image resolver for IR image blocks (http src is not fetched: SSRF-safe). */
  private imageResolver(uid: string | undefined): ImageResolver | undefined {
    const download = this.options.cloud.downloadFile;
    if (!uid || !download) return undefined;
    return async (image: IRImage) => {
      if (!image.uploadUuid) return undefined;
      try {
        const file = await download.call(this.options.cloud, uid, image.uploadUuid);
        if (!file.data || file.data.byteLength === 0) return undefined;
        return { data: file.data, mime: file.contentType || "image/png" };
      } catch (err) {
        log.warn(
          "[OFFICE-EXPORT] image download failed uuid=%s: %s",
          image.uploadUuid,
          err instanceof Error ? err.message : String(err),
        );
        return undefined;
      }
    };
  }

  /**
   * Destination precedence: explicit folderId > agent/<folderPath> > agent/.
   * The agent folder is the product default, so a missing folder is created
   * rather than silently dropping the file into the drive root.
   */
  private async resolveFolder(uid: string, spec: OfficeExportSpec): Promise<{ folderId: number; label: string }> {
    if (typeof spec.folderId === "number" && Number.isFinite(spec.folderId) && spec.folderId > 0) {
      return { folderId: spec.folderId, label: "云盘文件夹 #" + spec.folderId };
    }
    if (!this.options.folders) {
      throw new OfficeExportError("cloud_unavailable", "未配置云盘目录服务，无法定位 agent 导出目录");
    }
    try {
      const folder = await this.options.folders.ensurePath(uid, spec.folderPath);
      return { folderId: folder.folderId, label: folder.path };
    } catch (err) {
      if (err instanceof CloudFolderError) {
        // Older app-cloud without the M2M folder listing: the file still has to
        // land somewhere, so write to the drive root and tell the operator the
        // one-step fix (rebuild + restart app-cloud restores agent/ routing).
        if (err.status === 404) {
          log.warn("[OFFICE-EXPORT] agent folder endpoint missing; falling back to drive root: %s", err.message);
          return {
            folderId: 0,
            label: "云盘根目录（agent/ 目录接口未就绪：请重新构建并重启 app-cloud，之后会自动写入 agent/）",
          };
        }
        throw new OfficeExportError(err.code === "invalid" ? "invalid" : "cloud_unavailable", err.message);
      }
      throw err;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private checkSize(bytes: Buffer): Buffer {
    const limit = this.options.maxBytes ?? OFFICE_LIMITS.outputBytes;
    if (bytes.byteLength > limit) {
      throw new OfficeExportError(
        "too_large",
        "生成的文件超过 " + Math.round(limit / (1024 * 1024)) + "MB 上限，请减少表格行数/页数或拆分文档",
      );
    }
    return bytes;
  }
}

export { OfficeExportError } from "./errors.js";
export type { DocxBlock, PptxSlide, OfficeExportSpec, XlsxSheet } from "./types.js";
export { baseNameOf };
