import type { AppCloudClient } from "../clients/app-cloud-client.js";
import { AppCloudError } from "../clients/app-cloud-client.js";
import { createLogger } from "../logger.js";
import { DOCX_MIME } from "../doc-parser/docx.js";
import {
  DEFAULT_SUMMARY_CHARS,
  MAX_DOCX_BYTES,
  parseDocxDetail,
  renderDocxDetailText,
} from "../doc-parser/docx-detail.js";
import { parsePptxDetail, renderPptxDetailText } from "../doc-parser/pptx-detail.js";
import { parseXlsxDetail, renderXlsxDetailText } from "../doc-parser/xlsx-detail.js";
import type { ChatImageStorage } from "../repository/chat-images.js";
import type { SessionDocumentMeta, SessionDocumentRepository } from "../repository/session-docs.js";
import { OfficeRenderError, type OfficeRenderPort } from "./office-render/renderer.js";
import { VisionReviewError, type VisionReviewPort } from "./office-render/vision.js";
import { buildOfficeDocumentArtifact, type OfficeDocumentData } from "../artifacts/office-document.js";
import { parseDocxDocumentPreview } from "../doc-parser/docx-blocks.js";

const log = createLogger("OFFICE-REVIEW");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Office document reading service: the two ways an agent can "understand" a
 * user-supplied Word/Excel/PPT file.
 *
 *   inspect()     -- structure only: headings/cells/slides, tables, formulas,
 *                    theme-less layout facts. Cheap, deterministic, always works.
 *   visualCheck() -- render pages to PNG (LibreOffice) and let a VISION model
 *                    look at them, returning actionable layout findings. This is
 *                    the fallback for models that cannot take the Office file
 *                    itself, and the feedback loop for "generate -> look -> fix".
 *
 * Source resolution mirrors docx_inspect: a conversation upload (session
 * document + attachment storage) or a cloud-drive file (app-cloud M2M). Every
 * expected failure returns Chinese guidance text, never a thrown error, so the
 * ReAct loop can correct itself (re-upload, different source, ask the user).
 */

export type OfficeFormat = "docx" | "xlsx" | "pptx";

export interface OfficeDocumentInput {
  uid?: string;
  chatSessionId?: string;
  source?: "session" | "cloud";
  /** Session upload: file name or session document id. */
  sessionDocument?: string;
  /** Cloud drive: upload_uuid. */
  uploadUuid?: string;
}

export interface OfficeDocumentDeps {
  cloud?: Pick<AppCloudClient, "configured" | "downloadFile">;
  sessionDocs?: SessionDocumentRepository;
  sessionFiles?: Pick<ChatImageStorage, "getBytes">;
  renderer: OfficeRenderPort;
  vision: VisionReviewPort;
  limits: {
    maxSourceBytes: number;
    defaultPages: number;
    maxPages: number;
    maxImages: number;
    renderTimeoutMs: number;
    dpi: number;
    visionTimeoutMs: number;
  };
}

interface LoadedDocument {
  bytes: Uint8Array;
  name: string;
  mime?: string;
  format: OfficeFormat;
}

type LoadResult =
  | { ok: true; doc: LoadedDocument }
  | { ok: false; guidance: string; status?: number };

const NO_USER_TEXT = "当前会话没有用户身份，无法读取云盘文件。";
const NO_SESSION_TEXT = "当前对话没有会话 id，无法读取会话上传的文档；可改用 uploadUuid 读取云盘文件。";
const NO_ATTACHMENT_STORAGE = "会话文档读取未启用（附件存储不可用）；请改用 uploadUuid 读取云盘文件。";
const CLOUD_DISABLED = "云盘服务未启用（app-cloud 未配置），暂时无法读取云盘文件。";
const CLOUD_UNAVAILABLE = "云盘服务暂不可用，无法读取文件，请稍后重试。";

function trimText(value: string | undefined): string {
  return (value ?? "").trim();
}

function extOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/** Format from mime first, then file name; undefined = unsupported. */
function formatOf(name: string, mime?: string): OfficeFormat | undefined {
  const declared = (mime ?? "").toLowerCase();
  if (declared === DOCX_MIME) return "docx";
  if (declared === XLSX_MIME) return "xlsx";
  if (declared === PPTX_MIME) return "pptx";
  const ext = extOf(name);
  if (ext === "docx" || ext === "xlsx" || ext === "pptx") return ext;
  return undefined;
}

function findSessionDoc(docs: readonly SessionDocumentMeta[], wanted: string): SessionDocumentMeta | undefined {
  return (
    docs.find((doc) => doc.id === wanted) ??
    docs.find((doc) => doc.filename === wanted) ??
    docs.find((doc) => doc.filename.toLowerCase() === wanted.toLowerCase())
  );
}

/** Evenly spaced page sample so "look at 6 of 30 pages" still covers the deck. */
export function samplePages<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  if (limit <= 0) return [];
  const step = (items.length - 1) / (limit - 1 || 1);
  const picked: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round(i * step);
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(items[index]);
  }
  return picked;
}

/** Outcome of a document preview request (route maps it to HTTP). */
export interface DocumentPreviewResult {
  available: boolean;
  detail?: string;
  data?: OfficeDocumentData;
  status?: number;
}

export class OfficeDocumentService {
  constructor(private readonly deps: OfficeDocumentDeps) {}

  /** Structure summary of one document (docx / xlsx / pptx). */
  async inspect(input: OfficeDocumentInput, opts: { maxChars?: number; maxRows?: number } = {}): Promise<string> {
    const loaded = await this.load(input);
    if (!loaded.ok) return loaded.guidance;
    const { doc } = loaded;
    const maxChars = opts.maxChars && opts.maxChars > 0 ? Math.min(opts.maxChars, 20_000) : DEFAULT_SUMMARY_CHARS;
    try {
      if (doc.format === "docx") {
        const parsed = await parseDocxDetail(doc.bytes);
        if (!parsed.ok) return "Word 结构解析失败：" + parsed.error;
        return renderDocxDetailText(parsed.detail, { name: doc.name, maxChars });
      }
      if (doc.format === "pptx") {
        const detail = await parsePptxDetail(Buffer.from(doc.bytes));
        return renderPptxDetailText(detail, { maxChars });
      }
      const detail = await parseXlsxDetail(Buffer.from(doc.bytes), {
        ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
      });
      return renderXlsxDetailText(detail, { maxChars });
    } catch (err) {
      log.warn("[OFFICE-REVIEW] inspect failed: %s", err instanceof Error ? err.message : String(err));
      return "Office 结构解析失败：" + (err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Visual review: render pages, show them in the transcript and ask the vision
   * model what is wrong. Every degradation path explains what to do instead.
   *
   * The rendered pages are returned as `preview` even when no vision model is
   * configured: "show me what this file looks like" is useful on its own, and the
   * frontend renders the pages as an image card.
   */
  async visualCheck(
    input: OfficeDocumentInput,
    opts: { pages?: number[]; maxPages?: number; focus?: string } = {},
  ): Promise<string> {
    const loaded = await this.load(input);
    if (!loaded.ok) return loaded.guidance;
    const { doc } = loaded;
    if (doc.bytes.byteLength > this.deps.limits.maxSourceBytes) {
      return (
        "文件超过视觉复核上限（" +
        Math.round(this.deps.limits.maxSourceBytes / 1024 / 1024) +
        "MB），已跳过渲染；可改用 office_inspect 看结构文本。"
      );
    }
    if (!this.deps.renderer.available) {
      return (
        "视觉复核暂不可用：" +
        (this.deps.renderer.unavailableReason ?? "渲染器未安装") +
        " 可先用 office_inspect 查看结构文本，或直接按用户描述修改内容。"
      );
    }

    let rendered: Awaited<ReturnType<OfficeRenderPort["render"]>>;
    try {
      rendered = await this.deps.renderer.render(
        { fileName: doc.name, bytes: doc.bytes, ...(opts.pages ? { pages: opts.pages } : {}) },
        {
          maxPages: Math.min(this.deps.limits.maxPages, opts.maxPages ?? this.deps.limits.defaultPages),
          timeoutMs: this.deps.limits.renderTimeoutMs,
          dpi: this.deps.limits.dpi,
        },
      );
    } catch (err) {
      if (err instanceof OfficeRenderError) {
        return "渲染失败（" + err.code + "）：" + err.message + " 可改用 office_inspect 看结构文本。";
      }
      throw err;
    }
    const pageNumbers = rendered.map((page) => page.page);
    if (!this.deps.vision.enabled) {
      return (
        "已渲染 " + rendered.length + " 页（第 " + pageNumbers.join("、") + " 页），但未配置视觉模型，无法看图评审；" +
        "可改用 office_inspect 看结构文本，或配置视觉模型后重试。"
      );
    }

    const picked = samplePages(rendered, this.deps.limits.maxImages);
    const instructions = this.buildInstructions(doc, picked.map((page) => page.page), opts.focus);
    try {
      const findings = await this.deps.vision.review({
        instructions,
        images: picked.map((page) => ({ page: page.page, data: page.png })),
      });
      return (
        "【视觉复核】" + doc.name + "（已渲染 " + rendered.length + " 页，送审第 " +
        picked.map((page) => page.page).join("、") +
        " 页）\n" + findings
      );
    } catch (err) {
      if (err instanceof VisionReviewError) return "视觉复核失败：" + err.message;
      throw err;
    }
  }

  /**
   * Structured Word preview for the cloud UI (no screenshots): reads the stored
   * .docx over the app-cloud M2M face and returns the same block payload the
   * chat document card renders. `name` comes from the UI (the M2M download does
   * not return a file name).
   */
  async documentPreview(
    uid: string,
    uploadUuid: string,
    opts: { name?: string } = {},
  ): Promise<DocumentPreviewResult> {
    const loaded = await this.load({ uid, uploadUuid, source: "cloud" });
    if (!loaded.ok) {
      return { available: false, detail: loaded.guidance, ...(loaded.status ? { status: loaded.status } : {}) };
    }
    const { doc } = loaded;
    if (doc.format !== "docx") {
      return { available: false, detail: "目前只支持 Word（.docx）的在线预览，其他格式请下载查看。" };
    }
    let preview: Awaited<ReturnType<typeof parseDocxDocumentPreview>>;
    try {
      preview = await parseDocxDocumentPreview(doc.bytes);
    } catch (err) {
      log.warn("[OFFICE-REVIEW] docx preview failed: %s", err instanceof Error ? err.message : String(err));
      return { available: false, detail: "文档预览解析失败，请下载后查看。" };
    }
    if (!preview.ok) return { available: false, detail: "Word 文档预览失败：" + preview.error };
    const built = buildOfficeDocumentArtifact({
      name: trimText(opts.name) || doc.name,
      format: "docx",
      uploadUuid,
      ...(preview.preview.title ? { meta: { title: preview.preview.title } } : {}),
      blocks: preview.preview.blocks,
      truncated: preview.preview.truncated,
    });
    if (!built.ok) return { available: false, detail: "文档预览数据不完整：" + built.error };
    return { available: true, data: built.artifact.data as OfficeDocumentData };
  }

  private buildInstructions(doc: LoadedDocument, pages: number[], focus?: string): string {
    const lines = [
      "你是严格的版式审查员。下面是《" + doc.name + "》渲染出的页面图片（第 " + pages.join("、") + " 页）。",
      "请只报告你能从图片中确认的问题，按下面的顺序输出中文清单：",
      "1) 文字问题：溢出、被裁切、重叠、字号过小、断行难看；",
      "2) 版式问题：对齐、留白、行距、页边距、内容超出页面；",
      "3) 表格/图片：列宽不合理、表头缺失、图片变形或缺失；",
      "4) 一致性问题：标题层级、页码/页脚、同一文档内的风格不统一；",
      "5) 逐页修改建议：每条给出「第几页 + 具体怎么改」，可执行、不要泛泛而谈。",
    ];
    if (focus && focus.trim() !== "") lines.push("额外关注点：" + focus.trim());
    lines.push("不要复述全文，不要猜测看不到的内容；没有问题就说没有问题。");
    return lines.join("\n");
  }

  private async load(input: OfficeDocumentInput): Promise<LoadResult> {
    const hasSession = trimText(input.sessionDocument) !== "";
    const hasCloud = trimText(input.uploadUuid) !== "";
    const source = input.source ?? (hasCloud && !hasSession ? "cloud" : "session");
    if (input.source === undefined && hasSession && hasCloud) {
      return { ok: false, guidance: "同时提供了 sessionDocument 与 uploadUuid，请用 source 明确来源（session=本会话上传，cloud=云盘文件）。" };
    }
    const result = source === "cloud" ? await this.loadCloud(input) : await this.loadSession(input);
    if (!result.ok) return result;
    const format = formatOf(result.name, result.mime);
    if (!format) {
      return { ok: false, guidance: "仅支持 .docx / .xlsx / .pptx（当前文件：" + result.name + "）。", status: 400 };
    }
    return { ok: true, doc: { bytes: result.bytes, name: result.name, mime: result.mime, format } };
  }

  private async loadSession(input: OfficeDocumentInput): Promise<
    { ok: true; bytes: Uint8Array; name: string; mime?: string } | { ok: false; guidance: string }
  > {
    const sessionId = trimText(input.chatSessionId);
    if (sessionId === "") return { ok: false, guidance: NO_SESSION_TEXT };
    const wanted = trimText(input.sessionDocument);
    if (wanted === "") {
      return { ok: false, guidance: "source=session 需要 sessionDocument（本会话上传的 Office 文件名或文档 id）。" };
    }
    const docsRepo = this.deps.sessionDocs;
    const files = this.deps.sessionFiles;
    if (!docsRepo || !files) return { ok: false, guidance: NO_ATTACHMENT_STORAGE };

    let docs: SessionDocumentMeta[];
    try {
      docs = await docsRepo.list(sessionId);
    } catch (err) {
      log.warn("[OFFICE-REVIEW] session list failed: %s", err instanceof Error ? err.message : String(err));
      return { ok: false, guidance: "读取本会话文档列表失败，请稍后重试。" };
    }
    if (docs.length === 0) {
      return { ok: false, guidance: "本会话还没有上传过文档；请先在对话里上传 .docx/.xlsx/.pptx，或用 uploadUuid 读取云盘文件。" };
    }
    const match = findSessionDoc(docs, wanted);
    if (!match) {
      const names = docs.map((doc) => doc.filename);
      return { ok: false, guidance: "本会话没有名为「" + wanted + "」的文档。本会话文档：" + names.join("、") + "。" };
    }
    if (!match.key) {
      return {
        ok: false,
        guidance:
          "「" + match.filename + "」的原件没有留存（上传时附件存储未启用或旧数据）；可让用户重新上传，或改用云盘 uploadUuid。",
      };
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await files.getBytes(match.key);
    } catch (err) {
      log.warn("[OFFICE-REVIEW] session bytes failed: %s", err instanceof Error ? err.message : String(err));
      bytes = undefined;
    }
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, guidance: "读取会话文档原件失败（对象存储不可用或文件已清理）；请让用户重新上传，或改用云盘 uploadUuid。" };
    }
    return {
      ok: true,
      bytes,
      name: match.filename,
      ...(match.contentType ? { mime: match.contentType } : {}),
    };
  }

  private async loadCloud(input: OfficeDocumentInput): Promise<
    | { ok: true; bytes: Uint8Array; name: string; mime?: string }
    | { ok: false; guidance: string; status?: number }
  > {
    const uid = trimText(input.uid);
    if (uid === "") return { ok: false, guidance: NO_USER_TEXT };
    const uploadUuid = trimText(input.uploadUuid);
    if (uploadUuid === "") return { ok: false, guidance: "source=cloud 需要 uploadUuid（云盘文件 id）。" };
    const cloud = this.deps.cloud;
    if (!cloud || !cloud.configured) return { ok: false, guidance: CLOUD_DISABLED, status: 503 };

    let downloaded: { contentType: string; data: Uint8Array };
    try {
      downloaded = await cloud.downloadFile(uid, uploadUuid);
    } catch (err) {
      if (err instanceof AppCloudError && err.status === 404) {
        return { ok: false, guidance: "云盘文件不存在或无权访问（uploadUuid: " + uploadUuid + "）。", status: 404 };
      }
      log.warn("[OFFICE-REVIEW] cloud download failed: %s", err instanceof Error ? err.message : String(err));
      return { ok: false, guidance: CLOUD_UNAVAILABLE, status: 503 };
    }
    if (!downloaded.data || downloaded.data.byteLength === 0) {
      return { ok: false, guidance: "云盘文件为空或读取失败，无法解析。", status: 502 };
    }
    const mime = (downloaded.contentType ?? "").trim().toLowerCase();
    return {
      ok: true,
      bytes: downloaded.data,
      name: "云盘文件 " + uploadUuid,
      ...(mime !== "" ? { mime } : {}),
    };
  }
}

/** Re-exported so tools/tests can assert the format list without importing parsers. */
export const OFFICE_FORMATS: readonly OfficeFormat[] = ["docx", "xlsx", "pptx"];
export const OFFICE_MIMES = { docx: DOCX_MIME, xlsx: XLSX_MIME, pptx: PPTX_MIME } as const;
