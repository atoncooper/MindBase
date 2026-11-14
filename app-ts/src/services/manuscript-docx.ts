import type { AppCloudClient } from "../clients/app-cloud-client.js";
import { AppCloudError } from "../clients/app-cloud-client.js";
import { createLogger } from "../logger.js";
import {
  ACADEMIC_DOCUMENT_KINDS,
  type AcademicDocument,
  type AcademicDocumentExport,
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
  type AcademicDocumentSource,
  type AcademicProjectRepository,
  type AcademicSectionInput,
} from "../repository/academic.js";
import { AcademicError } from "./academic.js";
import { buildDocxBuffer } from "./docx-writer.js";
import { DOCX_MIME, isDocxFile, parseDocxSections } from "../doc-parser/docx.js";
import type { ResearchFolderKind, ResearchWorkspaceService } from "./research-workspace.js";

const log = createLogger("MANUSCRIPT-DOCX");

/** Upload cap for an existing manuscript (contract: docs/manuscript-docx.md §2.1). */
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

/** Sections are clamped to the same ceiling the section-save endpoint enforces. */
const MAX_SECTION_CHARS = 200_000;

/** Uniform message for every cloud-drive failure (contract §2.1/§2.2/§2.3: 503). */
const CLOUD_UNAVAILABLE = "云盘服务暂不可用，无法保存 Word 文件";

export interface ImportDocxInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Optional explicit title; falls back to the document first heading, then the file name. */
  title?: string;
  /** Optional document kind string; validated against ACADEMIC_DOCUMENT_KINDS (invalid -> 400). */
  kind?: string;
}

/**
 * Wire payload of POST /academic/projects/:projectId/documents/import-from-cloud:
 * a .docx that already lives in the project cloud drive (the bytes are not
 * re-uploaded; the same upload becomes the export template).
 */
export interface ImportDocxFromCloudInput {
  /** cloud-drive upload_uuid of an existing .docx */
  uploadUuid: string;
  /** Optional explicit title; falls back to the document first heading, then the file name. */
  title?: string;
  /** Optional document kind string; validated against ACADEMIC_DOCUMENT_KINDS (invalid -> 400). */
  kind?: string;
}

/** Wire payload of POST /academic/documents/:documentId/export/docx (§2.3). */
export interface ManuscriptDocxSaveResult {
  uploadUuid: string;
  fileName: string;
  folderId: number;
  createdAt: number;
}

/**
 * Ordered project folders of the academic workspace (contract:
 * docs/project-files.md §1). The labels are product strings (Chinese) and the
 * order is the list order the UI relies on.
 */
const PROJECT_FILE_FOLDERS: ReadonlyArray<{ kind: ResearchFolderKind; label: string }> = [
  { kind: "plan", label: "00_课题与计划" },
  { kind: "literature", label: "01_文献" },
  { kind: "data", label: "02_数据" },
  { kind: "code", label: "03_代码与实验" },
  { kind: "results", label: "04_结果" },
  { kind: "manuscript", label: "05_论文" },
  { kind: "submission", label: "06_投稿" },
];

/** Fixed read-path message when the cloud drive cannot answer for a project with a workspace. */
const CLOUD_UNAVAILABLE_READ = "云盘服务暂不可用，无法读取项目文件";

/** Where one aggregated project file entry came from (contract: docs/project-files.md §1). */
export type ProjectFileOrigin = "workspace" | "document-source" | "document-export";

/** One row of the aggregated project file list. */
export interface ProjectFileEntry {
  uploadUuid: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt?: number;
  origin: ProjectFileOrigin;
  /** workspace files only: folder identity and its Chinese label */
  folderKind?: ResearchFolderKind;
  folderLabel?: string;
  /** document-source / document-export files only */
  documentId?: string;
  documentTitle?: string;
}

/** One folder row of the workspace block. */
export interface ProjectWorkspaceFolder {
  kind: ResearchFolderKind;
  label: string;
  folderId: number;
}

/** Workspace block: a project without a research workspace still lists its documents. */
export type ProjectWorkspaceInfo =
  | { exists: false }
  | { exists: true; workspaceId: string; title: string; folders: ProjectWorkspaceFolder[] };

/** Wire payload of GET /academic/projects/:projectId/files (§1). */
export interface ProjectFilesResult {
  workspace: ProjectWorkspaceInfo;
  files: ProjectFileEntry[];
}

/** Injected ports; the composition root picks the implementations (app-ts/AGENTS.md §3). */
export interface ManuscriptDocxServiceDeps {
  /** Manuscript document contract (repository/academic.ts) — documents only. */
  documents: AcademicDocumentRepository;
  projects: AcademicProjectRepository;
  /** Project cloud-drive folder mapping (05_论文 uploads). */
  workspace: ResearchWorkspaceService;
  /** app-cloud M2M client (upload/download of the manuscript files). */
  cloud: AppCloudClient;
}

/** Browser-sent file names may carry a path; keep a plain, safe file name. */
function sanitizeFileName(name: string): string {
  const base = (name ?? "").replace(/^.*[\\/]/, "").trim();
  return base.length > 0 ? base.slice(0, 200) : "manuscript.docx";
}

/** File name stem without the .docx extension (fallback document title). */
function stripDocxExtension(name: string): string {
  return name.replace(/\.docx$/i, "").trim();
}

/**
 * Escapes a title for the cloud file name: Word titles often contain
 * ":" "/" "?" which are illegal in MinIO object keys on some clients.
 */
function sanitizeTitlePart(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "manuscript";
}

/** Local-time yyyyMMddHHmm stamp used by the cloud file name. */
function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

/** Appends _2/_3/... before the extension when the requested name already exists. */
export function uniqueDocxName(baseName: string, taken: ReadonlySet<string>): string {
  if (!taken.has(baseName)) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extension = dot > 0 ? baseName.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = stem + "_" + index + extension;
    if (!taken.has(candidate)) return candidate;
  }
  return stem + "_" + Date.now().toString(36) + extension;
}

/** Resolves the optional kind string; an unknown value is a user error, not a 500. */
function parseDocumentKind(value: string | undefined): AcademicDocumentKind {
  const raw = (value ?? "").trim();
  if (raw === "") return "draft";
  if (!(ACADEMIC_DOCUMENT_KINDS as readonly string[]).includes(raw)) {
    throw new AcademicError(400, "文档类型不合法（可选：" + ACADEMIC_DOCUMENT_KINDS.join(" / ") + "）");
  }
  return raw as AcademicDocumentKind;
}

/**
 * Word (.docx) import / export for the academic manuscript workspace.
 *
 * Layer: service orchestration (contract: docs/manuscript-docx.md). It owns the
 * cloud-drive mapping (05_论文 via ResearchWorkspaceService), the template
 * round-trip (an imported document keeps its own .docx package as the export
 * template) and the document/source/lastExport bookkeeping; OOXML authoring stays
 * in services/docx-writer.ts and docx parsing in src/doc-parser/docx.ts, while
 * storage stays behind the repository contract.
 *
 * Invariants:
 *  - uid first on every call; a foreign project/document is 404 (never a 403 that
 *    leaks existence);
 *  - the cloud drive is the storage owner: every failure to reach it (or to
 *    ensure the project folder tree) surfaces as 503 with one fixed message, so
 *    the UI can offer a retry without string matching;
 *  - the uploaded original is recorded as document.source and re-downloaded as
 *    the export template, so a user-provided Word layout is preserved across the
 *    agent/human editing round-trip.
 */
export class ManuscriptDocxService {
  constructor(private readonly deps: ManuscriptDocxServiceDeps) {}

  /**
   * Imports an existing .docx user manuscript (§2.1): ensure the project folder
   * tree -> upload the original into 05_论文 -> parse sections -> create the
   * document with its source record. The order follows the contract: the cloud
   * copy exists even if parsing surprises us, and the source byte stream is the
   * single template for every later export.
   */
  async importDocx(
    uid: string,
    projectId: string,
    input: ImportDocxInput,
  ): Promise<{ document: AcademicDocument; source: AcademicDocumentSource }> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");

    const fileName = sanitizeFileName(input.fileName);
    if (!isDocxFile(fileName, input.mimeType)) {
      throw new AcademicError(
        422,
        "仅支持 .docx 文件（application/vnd.openxmlformats-officedocument.wordprocessingml.document）",
      );
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.byteLength === 0) throw new AcademicError(422, "Word 文件为空");
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new AcademicError(422, "Word 文件过大（上限 20MB）");
    if (!this.deps.cloud.configured) throw this.cloudUnavailable();

    const kind = parseDocumentKind(input.kind);
    // Only .docx is accepted, so the canonical Word mime is stored on the source
    // record and sent to app-cloud (browsers may send application/octet-stream).
    const mimeType = DOCX_MIME;

    await this.ensureWorkspace(uid, projectId, project.title);
    let uploaded: { upload_uuid: string; name: string; folderId: number };
    try {
      uploaded = await this.deps.workspace.uploadFile(uid, projectId, "manuscript", fileName, bytes, mimeType);
    } catch (err) {
      throw this.cloudUnavailable(err);
    }

    let parsed: Awaited<ReturnType<typeof parseDocxSections>>;
    try {
      parsed = await parseDocxSections(bytes);
    } catch (err) {
      throw new AcademicError(
        422,
        "Word 文档解析失败（文件可能已损坏或不是有效的 .docx）：" + (err instanceof Error ? err.message : String(err)),
      );
    }

    const title =
      (input.title?.trim() || parsed.title?.trim() || stripDocxExtension(fileName)).slice(0, 200) || "Word 文档";
    // Repositories derive stable section keys from titles; order keeps the Word order.
    const sections: AcademicSectionInput[] = parsed.sections.map((section, index) => ({
      title: section.title.slice(0, 200) || "章节 " + (index + 1),
      content: section.content.slice(0, MAX_SECTION_CHARS),
      order: index,
    }));

    const source: AcademicDocumentSource = {
      uploadUuid: uploaded.upload_uuid,
      fileName: uploaded.name || fileName,
      mimeType,
      ...(Number.isFinite(uploaded.folderId) ? { folderId: uploaded.folderId } : {}),
    };
    const document = await this.deps.documents.createDocument(uid, projectId, {
      kind,
      title,
      sections,
      source,
    });
    log.info(
      "[MANUSCRIPT-DOCX] imported uid=%s project_id=%s document_id=%s sections=%d source=%s",
      uid,
      projectId,
      document.id,
      document.sections.length,
      source.uploadUuid,
    );
    return { document, source: document.source ?? source };
  }

  /**
   * Imports a Word file that already lives in the project cloud drive as a
   * manuscript document (no re-upload): the same upload_uuid is recorded as
   * document.source, so every later export reuses it as the layout template.
   *
   * The upload is first located across the seven project folders to recover its
   * real name/folder (best-effort: folder listing failures are tolerated), then
   * downloaded through app-cloud (uid-scoped: a foreign file is a 404).
   */
  async importDocxFromCloud(
    uid: string,
    projectId: string,
    input: ImportDocxFromCloudInput,
  ): Promise<{ document: AcademicDocument; source: AcademicDocumentSource }> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");
    const uploadUuid = (input.uploadUuid ?? "").trim();
    if (uploadUuid === "") throw new AcademicError(422, "缺少 uploadUuid（项目云盘文件 id）");
    const kind = parseDocumentKind(input.kind);
    if (!this.deps.cloud.configured) throw this.cloudUnavailable();

    // Metadata lookup only (name/mime/folderId); the download below is the
    // authoritative ownership check, so a miss here still allows the import.
    const located = await this.findProjectFile(uid, projectId, uploadUuid);

    let downloaded: { contentType: string; data: Uint8Array };
    try {
      downloaded = await this.deps.cloud.downloadFile(uid, uploadUuid);
    } catch (err) {
      if (err instanceof AppCloudError && err.status === 404) {
        throw new AcademicError(404, "云盘文件不存在或无权访问");
      }
      throw this.cloudUnavailable(err);
    }
    const bytes = Buffer.from(downloaded.data);
    if (bytes.byteLength === 0) throw new AcademicError(422, "Word 文件为空");
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new AcademicError(422, "Word 文件过大（上限 20MB）");

    const locatedName = (located?.name ?? "").trim();
    const fileName =
      locatedName !== ""
        ? sanitizeFileName(locatedName)
        : sanitizeFileName((input.title?.trim() || "imported") + ".docx");
    const mimeType = DOCX_MIME;
    if (!isDocxFile(fileName, downloaded.contentType || located?.mimeType)) {
      throw new AcademicError(422, "仅支持从项目云盘导入 .docx 文件");
    }

    let parsed: Awaited<ReturnType<typeof parseDocxSections>>;
    try {
      parsed = await parseDocxSections(bytes);
    } catch (err) {
      throw new AcademicError(
        422,
        "Word 文档解析失败（文件可能已损坏或不是有效的 .docx）：" + (err instanceof Error ? err.message : String(err)),
      );
    }

    const title =
      (input.title?.trim() || parsed.title?.trim() || stripDocxExtension(fileName)).slice(0, 200) || "Word 文档";
    const sections: AcademicSectionInput[] = parsed.sections.map((section, index) => ({
      title: section.title.slice(0, 200) || "章节 " + (index + 1),
      content: section.content.slice(0, MAX_SECTION_CHARS),
      order: index,
    }));
    const source: AcademicDocumentSource = {
      uploadUuid,
      fileName,
      mimeType,
      ...(located?.folderId !== undefined ? { folderId: located.folderId } : {}),
    };
    const document = await this.deps.documents.createDocument(uid, projectId, {
      kind,
      title,
      sections,
      source,
    });
    log.info(
      "[MANUSCRIPT-DOCX] imported from cloud uid=%s project_id=%s document_id=%s sections=%d source=%s",
      uid,
      projectId,
      document.id,
      document.sections.length,
      uploadUuid,
    );
    return { document, source: document.source ?? source };
  }

  /**
   * Renders the document as a .docx (§2.2). When the document came from an
   * uploaded Word file, that original is downloaded and reused as the template,
   * so styles/page setup survive; a missing/unreachable template degrades to the
   * standard package instead of failing the download (read paths stay usable
   * while the cloud drive is briefly down).
   */
  async exportDocxBuffer(
    uid: string,
    documentId: string,
  ): Promise<{ buffer: Buffer; title: string; fileName: string }> {
    const document = await this.requireDocument(uid, documentId);
    const template = await this.templateFor(uid, document, false);
    const buffer = await buildDocxBuffer({
      title: document.title,
      sections: document.sections.map((section) => ({ title: section.title, content: section.content })),
      ...(template ? { template } : {}),
    });
    return { buffer, title: document.title, fileName: sanitizeTitlePart(document.title) + ".docx" };
  }

  /**
   * Renders the document and stores it back into the project 05_论文 folder
   * (§2.3), then records lastExport. The file name is
   * title_yyyyMMddHHmm.docx with a numeric suffix on collision.
   */
  async exportDocxToCloud(uid: string, documentId: string): Promise<ManuscriptDocxSaveResult> {
    const document = await this.requireDocument(uid, documentId);
    const project = await this.deps.projects.get(uid, document.projectId);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");
    if (!this.deps.cloud.configured) throw this.cloudUnavailable();

    // Write path: the template must be available, otherwise the saved file would
    // silently drop the user layout. A deleted (404) source is the one case
    // where re-authoring from scratch is the right answer.
    const template = await this.templateFor(uid, document, true);
    const buffer = await buildDocxBuffer({
      title: document.title,
      sections: document.sections.map((section) => ({ title: section.title, content: section.content })),
      ...(template ? { template } : {}),
    });

    await this.ensureWorkspace(uid, project.id, project.title);
    const baseName = sanitizeTitlePart(document.title) + "_" + formatStamp(new Date()) + ".docx";
    const fileName = await this.uniqueManuscriptName(uid, project.id, baseName);
    let uploaded: { upload_uuid: string; name: string; folderId: number };
    try {
      uploaded = await this.deps.workspace.uploadFile(uid, project.id, "manuscript", fileName, buffer, DOCX_MIME);
    } catch (err) {
      throw this.cloudUnavailable(err);
    }

    const lastExport: AcademicDocumentExport = {
      uploadUuid: uploaded.upload_uuid,
      fileName: uploaded.name || fileName,
      ...(Number.isFinite(uploaded.folderId) ? { folderId: uploaded.folderId } : {}),
      createdAt: Date.now(),
    };
    const updated = await this.deps.documents.updateDocument(uid, documentId, { lastExport });
    if (!updated) throw new AcademicError(404, "文档不存在或无权访问");
    log.info(
      "[MANUSCRIPT-DOCX] exported uid=%s document_id=%s upload=%s file=%s",
      uid,
      documentId,
      lastExport.uploadUuid,
      lastExport.fileName,
    );
    return {
      uploadUuid: lastExport.uploadUuid,
      fileName: lastExport.fileName,
      folderId: lastExport.folderId ?? uploaded.folderId,
      createdAt: lastExport.createdAt,
    };
  }

  /**
   * Aggregated project file list (contract: docs/project-files.md §1): the seven
   * cloud-drive folders of the project workspace plus the manuscript documents'
   * source/lastExport uploads.
   *
   * The read path is tolerant by design: one unreachable folder only loses that
   * folder's rows (the response stays 200 with the rest), while a completely
   * unreachable cloud drive for a project that does have a workspace is a 503 so
   * the UI can offer a retry. A project without a workspace still returns its
   * document entries.
   *
   * Order (contract): folder order -> newest first inside a folder -> document
   * entries. Duplicate uploads keep the workspace row (documents are skipped).
   */
  async listProjectFiles(uid: string, projectId: string): Promise<ProjectFilesResult> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");

    const workspace = await this.deps.workspace.findByProject(uid, projectId);
    const projectWorkspace = workspace?.projects.find((entry) => entry.projectId === projectId);
    const files: ProjectFileEntry[] = [];
    const seen = new Set<string>();
    let workspaceInfo: ProjectWorkspaceInfo = { exists: false };

    if (workspace && projectWorkspace) {
      if (!this.deps.cloud.configured) throw this.readCloudUnavailable();
      workspaceInfo = {
        exists: true,
        workspaceId: workspace.workspaceId,
        title: workspace.title,
        folders: PROJECT_FILE_FOLDERS.map(({ kind, label }) => ({
          kind,
          label,
          folderId: projectWorkspace.folders[kind],
        })),
      };
      let listed = 0;
      let failed = 0;
      for (const { kind, label } of PROJECT_FILE_FOLDERS) {
        let folderFiles: Awaited<ReturnType<ResearchWorkspaceService["listFiles"]>>;
        try {
          folderFiles = await this.deps.workspace.listFiles(uid, projectId, kind);
        } catch (err) {
          failed += 1;
          log.warn(
            "[MANUSCRIPT-DOCX] project folder listing failed uid=%s project_id=%s kind=%s: %s",
            uid,
            projectId,
            kind,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        listed += 1;
        const entries = folderFiles
          .filter((file) => typeof file.upload_uuid === "string" && file.upload_uuid !== "")
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .map<ProjectFileEntry>((file) => ({
            uploadUuid: file.upload_uuid,
            name: file.name,
            size: file.size,
            mimeType: file.mime_type,
            ...(typeof file.createdAt === "number" ? { createdAt: file.createdAt } : {}),
            origin: "workspace",
            folderKind: kind,
            folderLabel: label,
          }));
        for (const entry of entries) {
          if (seen.has(entry.uploadUuid)) continue;
          seen.add(entry.uploadUuid);
          files.push(entry);
        }
      }
      // Nothing could be read at all: the drive is down, not an empty project.
      if (listed === 0 && failed > 0) throw this.readCloudUnavailable();
    }

    const documents = await this.deps.documents.listDocuments(uid, projectId);
    const addDocumentFile = (entry: ProjectFileEntry): void => {
      if (entry.uploadUuid === "" || seen.has(entry.uploadUuid)) return;
      seen.add(entry.uploadUuid);
      files.push(entry);
    };
    for (const document of documents) {
      const source = document.source;
      if (source) {
        addDocumentFile({
          uploadUuid: source.uploadUuid,
          name: source.fileName,
          size: 0,
          mimeType: source.mimeType,
          origin: "document-source",
          documentId: document.id,
          documentTitle: document.title,
        });
      }
      const lastExport = document.lastExport;
      if (lastExport) {
        addDocumentFile({
          uploadUuid: lastExport.uploadUuid,
          name: lastExport.fileName,
          size: 0,
          mimeType: DOCX_MIME,
          ...(typeof lastExport.createdAt === "number" ? { createdAt: lastExport.createdAt } : {}),
          origin: "document-export",
          documentId: document.id,
          documentTitle: document.title,
        });
      }
    }
    return { workspace: workspaceInfo, files };
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Locates one project upload by uuid across the seven folders. Best-effort:
   * an unreadable folder is skipped (the caller's download is the real access
   * check), and a project without a workspace simply returns undefined.
   */
  private async findProjectFile(
    uid: string,
    projectId: string,
    uploadUuid: string,
  ): Promise<{ name: string; mimeType: string; folderId?: number; kind: ResearchFolderKind } | undefined> {
    const workspace = await this.deps.workspace.findByProject(uid, projectId);
    const projectWorkspace = workspace?.projects.find((entry) => entry.projectId === projectId);
    if (!projectWorkspace) return undefined;
    for (const { kind } of PROJECT_FILE_FOLDERS) {
      try {
        const files = await this.deps.workspace.listFiles(uid, projectId, kind);
        const file = files.find((candidate) => candidate.upload_uuid === uploadUuid);
        if (!file) continue;
        const folderId = file.folder_id ?? projectWorkspace.folders[kind];
        return {
          name: file.name,
          mimeType: file.mime_type,
          ...(typeof folderId === "number" ? { folderId } : {}),
          kind,
        };
      } catch (err) {
        log.warn(
          "[MANUSCRIPT-DOCX] cloud file lookup skipped uid=%s project_id=%s kind=%s: %s",
          uid,
          projectId,
          kind,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return undefined;
  }

  /** Loads a document, mapping a missing/foreign id to 404 (contract semantics). */
  private async requireDocument(uid: string, documentId: string): Promise<AcademicDocument> {
    const document = await this.deps.documents.getDocument(uid, documentId);
    if (!document) throw new AcademicError(404, "文档不存在或无权访问");
    return document;
  }

  /**
   * Downloads the uploaded original for template reuse. required is the write
   * path (a missing template is a 503 so the user keeps their layout); the read
   * path falls back to the standard package on any failure.
   */
  private async templateFor(
    uid: string,
    document: AcademicDocument,
    required: boolean,
  ): Promise<Uint8Array | undefined> {
    const source = document.source;
    if (!source) return undefined;
    try {
      if (!this.deps.cloud.configured) throw this.cloudUnavailable();
      const file = await this.deps.cloud.downloadFile(uid, source.uploadUuid);
      return file.data;
    } catch (err) {
      const status = err instanceof AppCloudError ? err.status : undefined;
      if (status === 404) {
        log.warn("[MANUSCRIPT-DOCX] source template missing, authoring standard package document_id=%s", document.id);
        return undefined;
      }
      if (required) throw this.cloudUnavailable(err);
      log.warn(
        "[MANUSCRIPT-DOCX] template unavailable, authoring standard package document_id=%s: %s",
        document.id,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  /** Ensures the project has its 00~06 folder tree; failures are cloud unavailability (503). */
  private async ensureWorkspace(uid: string, projectId: string, title: string): Promise<void> {
    try {
      const existing = await this.deps.workspace.findByProject(uid, projectId);
      if (existing) return;
      await this.deps.workspace.ensureProject(uid, projectId, title);
    } catch (err) {
      throw this.cloudUnavailable(err);
    }
  }

  /** Best-effort collision check against the 05_论文 listing; the base name is kept on failure. */
  private async uniqueManuscriptName(uid: string, projectId: string, baseName: string): Promise<string> {
    try {
      const files = await this.deps.workspace.listFiles(uid, projectId, "manuscript");
      return uniqueDocxName(baseName, new Set(files.map((file) => file.name)));
    } catch (err) {
      log.warn(
        "[MANUSCRIPT-DOCX] manuscript folder listing failed, reusing base name: %s",
        err instanceof Error ? err.message : String(err),
      );
      return baseName;
    }
  }

  /** Read-path 503: the project has a workspace but the cloud drive cannot answer. */
  private readCloudUnavailable(cause?: unknown): AcademicError {
    if (cause !== undefined) {
      log.warn(
        "[MANUSCRIPT-DOCX] project file listing unavailable: %s",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    return new AcademicError(503, CLOUD_UNAVAILABLE_READ);
  }

  /** One fixed 503 for every cloud-drive failure (cause is logged, never exposed). */
  private cloudUnavailable(cause?: unknown): AcademicError {
    if (cause !== undefined) {
      log.warn(
        "[MANUSCRIPT-DOCX] cloud drive unavailable: %s",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    return new AcademicError(503, CLOUD_UNAVAILABLE);
  }
}
