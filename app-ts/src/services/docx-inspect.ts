import { readFile } from "node:fs/promises";
import type { AppCloudClient } from "../clients/app-cloud-client.js";
import { AppCloudError } from "../clients/app-cloud-client.js";
import { createLogger } from "../logger.js";
import { DOCX_MIME, isDocxFile } from "../doc-parser/docx.js";
import {
  DEFAULT_SUMMARY_CHARS,
  MAX_DOCX_BYTES,
  parseDocxDetail,
  renderDocxDetailText,
  type DocxDetailFocus,
} from "../doc-parser/docx-detail.js";
import type { ChatImageStorage } from "../repository/chat-images.js";
import type { SessionDocumentMeta, SessionDocumentRepository } from "../repository/session-docs.js";
import type { TempFileWorkspace } from "../context/temp-workspace.js";
import { getRequestContext } from "../context/request-context.js";

const log = createLogger("DOCX-INSPECT");

/**
 * Word (.docx) detail inspection: the SECOND parsing level exposed to the agent
 * as the docx_inspect tool.
 *
 * Level 1 (existing) stays server-side: manuscript import / section extraction
 * calls doc-parser/docx.ts `parseDocxSections` and never needs this service.
 * Level 2 is user-askable: "按原模板格式 / 表格结构 / 字体字号 / 页眉页脚 /
 * 页边距" — this service fetches the ORIGINAL bytes from either the conversation
 * upload (session document + attachment storage) or the project cloud drive
 * (app-cloud M2M download), validates type/size and renders the parsed detail
 * as Chinese summary text.
 *
 * When a TempFileWorkspace is wired, the bytes are materialized into a local
 * scratch file (per uid + turn) and read back from disk before parsing — the
 * "download → local file → parse" path. The file is NOT removed here: ChatService
 * disposes the whole turn directory in its finally block, so tools/models have no
 * delete capability at all (budget/guidance failures degrade to a readable text).
 *
 * Error policy: every expected failure (missing source, no original retained,
 * non-docx mime, oversize, cloud 404/503, parse failure) returns a Chinese
 * guidance string instead of throwing, so the ReAct loop can recover. Only an
 * internal bug (unexpected exception) propagates.
 */

export interface DocxInspectServiceDeps {
  /** Session-document metadata (filename / original-object key) of the current chat. */
  sessionDocs?: SessionDocumentRepository;
  /** Attachment storage byte reads for the ORIGINAL conversation upload. */
  sessionFiles?: Pick<ChatImageStorage, "getBytes">;
  /** app-cloud M2M client used to download a cloud-drive file. */
  cloud?: Pick<AppCloudClient, "configured" | "downloadFile">;
  /**
   * Create-only temp-file capability (docs/temp-files.md). Present = the original
   * is downloaded into a local scratch file and parsed from disk; absent = the
   * bytes are parsed in memory. The service can NEVER delete a scratch file: the
   * program disposes the turn directory when the whole agent turn ends.
   */
  tempFiles?: TempFileWorkspace;
}

export type DocxInspectSource = "session" | "cloud";

/** Identity + which file to inspect; all fields come from the authenticated context or tool args. */
export interface DocxInspectInput {
  uid?: string;
  chatSessionId?: string;
  /** Explicit source; inferred from the provided field when omitted. */
  source?: DocxInspectSource;
  /** Session upload: filename or session-document id. */
  sessionDocument?: string;
  /** Cloud drive: upload_uuid. */
  uploadUuid?: string;
}

export interface DocxInspectOptions {
  focus?: readonly DocxDetailFocus[];
  maxTables?: number;
  maxParagraphs?: number;
  maxRowsPerTable?: number;
  /** Character budget of the rendered summary (default 6000). */
  maxChars?: number;
}

interface DocxPayload {
  bytes: Uint8Array;
  /** Display label used in the summary header. */
  name: string;
  mime?: string;
}

type PayloadResult = { ok: true; payload: DocxPayload } | { ok: false; guidance: string };
type SourceResult = { source: DocxInspectSource } | { guidance: string };

const NO_USER_TEXT = "当前会话没有用户身份，无法读取云盘文件。";
const NO_SESSION_TEXT = "当前对话没有会话 id，无法读取会话上传的文档；可改用 uploadUuid 读取项目云盘里的 Word。";
const NO_ATTACHMENT_STORAGE = "会话文档读取未启用（附件存储不可用）；请改用 uploadUuid 读取项目云盘里的 Word。";
const CLOUD_DISABLED = "云盘服务未启用（app-cloud 未配置），暂时无法读取云盘文件。";
const CLOUD_UNAVAILABLE = "云盘服务暂不可用，无法读取文件，请稍后重试。";
const NOT_DOCX = "仅支持解析 .docx 文件（application/vnd.openxmlformats-officedocument.wordprocessingml.document）。";

function trimText(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Infers the source from the provided field; both/neither are answered with guidance. */
function resolveSource(input: DocxInspectInput): SourceResult {
  const hasSession = trimText(input.sessionDocument) !== "";
  const hasCloud = trimText(input.uploadUuid) !== "";
  if (input.source === "session" || input.source === "cloud") return { source: input.source };
  if (hasSession && hasCloud) {
    return {
      guidance:
        "同时提供了 sessionDocument 与 uploadUuid，请用 source 明确来源（source=session 读本会话上传，" +
        "source=cloud 读项目云盘）。",
    };
  }
  if (hasSession) return { source: "session" };
  if (hasCloud) return { source: "cloud" };
  return {
    guidance:
      "请提供要解析的 Word 来源：sessionDocument（本会话上传的 .docx 文件名/文档 id）或 uploadUuid（项目云盘文件 id）。",
  };
}

/** Matches a session document by id first, then filename (case-insensitive last). */
function findSessionDoc(docs: readonly SessionDocumentMeta[], wanted: string): SessionDocumentMeta | undefined {
  return (
    docs.find((doc) => doc.id === wanted) ??
    docs.find((doc) => doc.filename === wanted) ??
    docs.find((doc) => doc.filename.toLowerCase() === wanted.toLowerCase())
  );
}

/**
 * Service facade for detail inspection. Constructed once in the composition root
 * with the SAME session-document/cloud ports the manuscript tool uses, so a
 * conversation upload and a project cloud file resolve through one code path.
 */
export class DocxInspectService {
  constructor(private readonly deps: DocxInspectServiceDeps) {}

  /**
   * Loads the original .docx from the resolved source and returns the Chinese
   * detail summary. Never throws for expected failures (guidance text instead).
   */
  async inspect(input: DocxInspectInput, options: DocxInspectOptions = {}): Promise<string> {
    const resolved = resolveSource(input);
    if ("guidance" in resolved) return resolved.guidance;

    const loaded = resolved.source === "cloud" ? await this.loadCloud(input) : await this.loadSession(input);
    if (!loaded.ok) return loaded.guidance;

    const { payload } = loaded;
    if (payload.bytes.byteLength === 0) return "Word 文件为空，无法解析。";
    if (payload.bytes.byteLength > MAX_DOCX_BYTES) {
      return (
        "Word 文件过大（当前 " +
        (payload.bytes.byteLength / 1024 / 1024).toFixed(1) +
        "MB，上限 " +
        Math.round(MAX_DOCX_BYTES / 1024 / 1024) +
        "MB），已跳过详细解析。"
      );
    }

    return this.parseAndRender(payload, options, input.uid ?? getRequestContext()?.uid);
  }

  /**
   * Parses the payload, preferring the local temp file when the capability is
   * wired and a request context exists (download → local file → parse). The file
   * deliberately stays on disk until the turn is disposed by the program.
   */
  private async parseAndRender(
    payload: DocxPayload,
    options: DocxInspectOptions,
    uid: string | undefined,
  ): Promise<string> {
    const tempFiles = this.deps.tempFiles;
    const requestId = getRequestContext()?.requestId;
    if (tempFiles?.enabled && requestId) {
      const materialized = await tempFiles.materialize(requestId, uid, payload.bytes, payload.name, payload.mime);
      if (!materialized.ok) return materialized.error;
      let bytes: Uint8Array;
      try {
        const buffer = await readFile(materialized.path);
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } catch (err) {
        log.warn("[DOCX-INSPECT] temp file read failed: %s", err instanceof Error ? err.message : String(err));
        return "读取本地临时文件失败（临时目录不可用），请稍后重试。";
      }
      return this.renderDetail(bytes, payload.name, options);
    }
    return this.renderDetail(payload.bytes, payload.name, options);
  }

  /** Shared parse + summary rendering for both the temp-file and in-memory paths. */
  private async renderDetail(bytes: Uint8Array, name: string, options: DocxInspectOptions): Promise<string> {
    const parsed = await parseDocxDetail(bytes, {
      ...(options.focus ? { focus: options.focus } : {}),
      ...(options.maxParagraphs !== undefined ? { maxParagraphs: options.maxParagraphs } : {}),
      ...(options.maxTables !== undefined ? { maxTables: options.maxTables } : {}),
      ...(options.maxRowsPerTable !== undefined ? { maxRowsPerTable: options.maxRowsPerTable } : {}),
    });
    if (!parsed.ok) return "Word 文档详细解析失败：" + parsed.error;
    return renderDocxDetailText(parsed.detail, {
      name,
      ...(options.focus ? { focus: options.focus } : {}),
      maxChars: options.maxChars !== undefined && options.maxChars > 0 ? options.maxChars : DEFAULT_SUMMARY_CHARS,
    });
  }

  /** Conversation upload → original bytes from attachment storage (same bridge as manuscript import). */
  private async loadSession(input: DocxInspectInput): Promise<PayloadResult> {
    const sessionId = trimText(input.chatSessionId);
    if (sessionId === "") return { ok: false, guidance: NO_SESSION_TEXT };
    const wanted = trimText(input.sessionDocument);
    if (wanted === "") {
      return { ok: false, guidance: "source=session 需要 sessionDocument（本会话上传的 Word 文件名或文档 id）。" };
    }
    const docsRepo = this.deps.sessionDocs;
    const files = this.deps.sessionFiles;
    if (!docsRepo || !files) return { ok: false, guidance: NO_ATTACHMENT_STORAGE };

    let docs: SessionDocumentMeta[];
    try {
      docs = await docsRepo.list(sessionId);
    } catch (err) {
      log.warn("[DOCX-INSPECT] session document list failed: %s", err instanceof Error ? err.message : String(err));
      return { ok: false, guidance: "读取本会话文档列表失败，请稍后重试。" };
    }
    if (docs.length === 0) {
      return {
        ok: false,
        guidance: "本会话还没有上传过文档；请先在对话里上传 .docx，或用 uploadUuid 读取项目云盘里的 Word。",
      };
    }
    const match = findSessionDoc(docs, wanted);
    if (!match) {
      const docxNames = docs
        .filter((doc) => isDocxFile(doc.filename, doc.contentType))
        .map((doc) => doc.filename);
      return {
        ok: false,
        guidance:
          "本会话没有名为「" +
          wanted +
          "」的文档。" +
          (docxNames.length > 0 ? "本会话的 Word：" + docxNames.join("、") + "。" : "本会话也没有 .docx 文件。"),
      };
    }
    if (!isDocxFile(match.filename, match.contentType)) {
      return { ok: false, guidance: "「" + match.filename + "」不是 .docx 文件，无法按 Word 解析。" };
    }
    if (!match.key) {
      return {
        ok: false,
        guidance:
          "「" +
          match.filename +
          "」的原件没有留存（上传时附件存储未启用，或是旧数据），拿不到原始文件；" +
          "可让用户重新上传，或把文件放到项目云盘后用 uploadUuid 解析。",
      };
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await files.getBytes(match.key);
    } catch (err) {
      log.warn("[DOCX-INSPECT] session document bytes failed: %s", err instanceof Error ? err.message : String(err));
      bytes = undefined;
    }
    if (!bytes || bytes.byteLength === 0) {
      return {
        ok: false,
        guidance: "读取会话文档原件失败（对象存储不可用或文件已清理）；请让用户重新上传，或改用项目云盘 uploadUuid。",
      };
    }
    return {
      ok: true,
      payload: {
        bytes,
        name: match.filename,
        ...(match.contentType ? { mime: match.contentType } : {}),
      },
    };
  }

  /** Cloud drive → bytes over the app-cloud M2M download (uid-scoped, 404 = foreign/missing). */
  private async loadCloud(input: DocxInspectInput): Promise<PayloadResult> {
    const uid = trimText(input.uid);
    if (uid === "") return { ok: false, guidance: NO_USER_TEXT };
    const uploadUuid = trimText(input.uploadUuid);
    if (uploadUuid === "") {
      return { ok: false, guidance: "source=cloud 需要 uploadUuid（项目云盘文件 id）。" };
    }
    const cloud = this.deps.cloud;
    if (!cloud || !cloud.configured) return { ok: false, guidance: CLOUD_DISABLED };

    let downloaded: { contentType: string; data: Uint8Array };
    try {
      downloaded = await cloud.downloadFile(uid, uploadUuid);
    } catch (err) {
      if (err instanceof AppCloudError && err.status === 404) {
        return { ok: false, guidance: "云盘文件不存在或无权访问（uploadUuid: " + uploadUuid + "）。" };
      }
      log.warn("[DOCX-INSPECT] cloud download failed: %s", err instanceof Error ? err.message : String(err));
      return { ok: false, guidance: CLOUD_UNAVAILABLE };
    }
    if (!downloaded.data || downloaded.data.byteLength === 0) {
      return { ok: false, guidance: "云盘文件为空或读取失败，无法解析。" };
    }
    const mime = (downloaded.contentType ?? "").trim().toLowerCase();
    // The cloud file name is not part of the download payload: DOCX_MIME and the
    // generic binary type are accepted (the parser rejects a non-docx package),
    // any other declared type is a clear user error.
    if (mime !== "" && mime !== DOCX_MIME && mime !== "application/octet-stream") {
      return { ok: false, guidance: "云盘文件不是 .docx（声明类型：" + mime + "），无法按 Word 解析。" };
    }
    return {
      ok: true,
      payload: {
        bytes: downloaded.data,
        name: "云盘文件 " + uploadUuid,
        ...(mime !== "" ? { mime } : {}),
      },
    };
  }
}
