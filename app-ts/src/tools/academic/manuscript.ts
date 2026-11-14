import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import { AcademicError } from "../../services/academic.js";
import type { ManuscriptDocxService } from "../../services/manuscript-docx.js";
import type { SessionDocumentMeta, SessionDocumentRepository } from "../../repository/session-docs.js";
import type { ChatImageStorage } from "../../repository/chat-images.js";
import { DOCX_MIME, isDocxFile } from "../../doc-parser/docx.js";
import { buildFileArtifact } from "../../artifacts/file.js";
import {
  ACADEMIC_DOCUMENT_KINDS,
  ACADEMIC_DOCUMENT_KIND_LABELS,
  slugKey,
  wordCount,
  type AcademicDocument,
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
  type AcademicEventRepository,
  type AcademicProjectRepository,
  type AcademicSection,
  defaultManuscriptSections,
  type AcademicSectionInput,
} from "../../repository/academic.js";

/**
 * academic_manuscript: manuscript documents (proposal/plan/draft/revision/...)
 * and their sections. Writing happens section by section so the user can review
 * each block; exports are pure text + artifact (no files are written - the web
 * product has no local sandbox). export_docx is the one exception: it renders the
 * document as Word and saves it back into the project cloud drive (05_论文)
 * through the injected ManuscriptDocxService (contract: docs/manuscript-docx.md
 * §2.4), which is a service call, not local file I/O.
 *
 * Layer: agent tool layer over the injected document/project/event
 * repositories; no storage, filesystem, or network I/O happens here, and
 * exports are returned as tool text instead of being saved anywhere.
 *
 * import_docx resolves a Word from either a project cloud-drive file
 * (uploadUuid) or a conversation upload (sessionDocument = filename or session
 * document id): conversation uploads keep their ORIGINAL binary in attachment
 * storage, so the user never has to upload the same .docx twice.
 *
 * Document/section model: a document belongs to a project and owns an ordered
 * list of sections keyed by a stable slug (`key`), so saves/exports can address
 * a section even after its heading is renamed. New documents default to the six
 * standard paper sections; outline_update only reorders/renames/adds and never
 * overwrites existing section body text.
 *
 * Invariants: uid is never in the schema and every repository call is
 * uid-scoped; every action needs project_id, and document access is checked
 * against both uid and project so a foreign document id cannot be reached
 * through this tool.
 */

/** Repositories injected by the composition root; no adapters are constructed here. */
export interface AcademicManuscriptToolDeps {
  documents: AcademicDocumentRepository;
  projects: AcademicProjectRepository;
  events: AcademicEventRepository;
  /**
   * Word import/export (docs/manuscript-docx.md §2.4); absent when the cloud
   * drive was not assembled, in which case the Word actions answer with
   * guidance text.
   */
  docx?: Pick<ManuscriptDocxService, "exportDocxToCloud" | "importDocxFromCloud" | "importDocx">;
  /**
   * Conversation uploads: the session-document list plus attachment-storage byte
   * reads. Together they let import_docx reuse a Word the user uploaded in this
   * chat (its original binary lives in object storage, chat-files/*) instead of
   * demanding a second upload through the writing page. Absent → cloud-only.
   */
  sessionDocs?: SessionDocumentRepository;
  sessionFiles?: Pick<ChatImageStorage, "getBytes">;
}

/**
 * Guidance fallbacks returned instead of throwing: a missing uid, a foreign
 * project, or a missing/foreign document must degrade into text the ReAct loop
 * can recover from.
 */
const NO_USER_TEXT = "当前会话没有用户身份，无法访问学术工作区。";
const NO_PROJECT_TEXT = "项目不存在或无权访问。";
const NO_DOCUMENT_TEXT = "文档不存在或无权访问。";
const MISSING_PROJECT_TEXT =
  "缺少 project_id：请先用 academic_project(action=list) 查看研究项目，或 action=create 新建项目。";


/** LaTeX special characters and their replacements; applied in one pass by escapeLatex. */
const LATEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  "$": "\\$",
  "#": "\\#",
  "_": "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Escape every LaTeX-special character so user-supplied titles and bodies
 * cannot break the exported document or inject commands.
 */
function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (char) => LATEX_ESCAPES[char] ?? char);
}

/**
 * Epoch milliseconds to a UTC YYYY-MM-DD date for display; nullish input
 * becomes an empty string so callers can render their own "not set" text.
 */
function dateOf(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Document total = sum of section word counts (CJK-aware, via repository wordCount). */
function documentWordCount(doc: AcademicDocument): number {
  return doc.sections.reduce((sum, section) => sum + wordCount(section.content), 0);
}

/** Sections by ascending order; copies the array because repository records are shared with callers. */
function sortedSections(doc: AcademicDocument): AcademicSection[] {
  return [...doc.sections].sort((left, right) => left.order - right.order);
}

/** Section listing for create/list/save/outline output; an empty document gets explicit guidance text. */
function renderSections(doc: AcademicDocument): string {
  const sections = sortedSections(doc);
  if (sections.length === 0) return "（该文档还没有章节）";
  const lines = ["章节（按顺序）："];
  sections.forEach((section, index) => {
    lines.push(
      (index + 1) +
        ". [" +
        section.key +
        "] " +
        section.title +
        "（" +
        wordCount(section.content) +
        " 字）",
    );
  });
  return lines.join("\n");
}

/** Markdown export: H1 title plus H2 per section; blank bodies become a placeholder instead of an empty block. */
function toMarkdown(doc: AcademicDocument): string {
  const parts: string[] = ["# " + doc.title];
  for (const section of sortedSections(doc)) {
    parts.push("## " + section.title);
    const body = section.content.trim();
    parts.push(body.length > 0 ? body : "（暂无正文）");
  }
  return parts.join("\n\n");
}

/**
 * Minimal compilable article template; LaTeX-special characters are escaped in
 * titles and bodies. The preamble targets xelatex + ctex because section titles
 * and content are normally Chinese, and escaping prevents user text from
 * injecting LaTeX commands.
 */
function toLatex(doc: AcademicDocument): string {
  const lines: string[] = [
    "% 由 MindBase 学术工作区导出（academic_manuscript）；中文请用 xelatex 编译（ctex 宏包）",
    "\\documentclass[11pt]{article}",
    "\\usepackage[UTF8]{ctex}",
    "\\usepackage{hyperref}",
    "\\usepackage[margin=2.5cm]{geometry}",
    "\\title{" + escapeLatex(doc.title) + "}",
    "\\author{}",
    "\\date{\\today}",
    "\\begin{document}",
    "\\maketitle",
    "",
  ];
  for (const section of sortedSections(doc)) {
    lines.push("\\section{" + escapeLatex(section.title) + "}");
    const body = section.content.trim();
    lines.push(body.length > 0 ? escapeLatex(body) : "% （本节暂无正文）");
    lines.push("");
  }
  lines.push("\\end{document}");
  return lines.join("\n");
}

/** Emit a typed manuscript artifact (document, section, or export text) for the web client. */
function pushManuscriptArtifact(ctx: ToolRunContext, data: Record<string, unknown>): void {
  ctx.collector.pushArtifacts([{ kind: "academic_manuscript", data }]);
}

/**
 * Outline item schema. content is honored only by create_document;
 * outline_update ignores it by contract so reordering cannot overwrite prose.
 */
const outlineSectionSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9-_]+$/, "章节 key 只能包含小写字母、数字、- 和 _")
    .max(50)
    .optional()
    .describe("章节 key（改名/重排已有章节时必须带已有 key；新增章节可省略，按标题生成）"),
  title: z.string().min(1).max(200).describe("章节标题"),
  content: z.string().optional().describe("章节正文（create_document 可选；outline_update 会忽略，不会覆盖正文）"),
  order: z.number().int().min(0).optional().describe("显示顺序（升序，缺省按数组顺序）"),
});

/** Tool input schema. uid is intentionally absent: identity comes from ToolRunContext. */
const manuscriptInputSchema = z.object({
  action: z
    .enum([
      "create_document",
      "documents",
      "list",
      "read",
      "save",
      "outline_update",
      "export_markdown",
      "export_latex",
      "export_docx",
      "import_docx",
    ])
    .describe(
      "create_document=新建写作文档；documents=列出项目文档；list=列章节；read=读章节正文；save=写入/更新章节；outline_update=重排/改名/新增章节；export_markdown/export_latex=拼接导出文本；export_docx=生成 Word 并回存到项目云盘 05_论文（可在写作页下载）；import_docx=把已有 .docx 导入为写作文档并作为导出模板（uploadUuid=项目云盘文件，或 sessionDocument=本会话上传的 Word 文件名/id，后者原件已在对象存储中，无需让用户重新上传）",
    ),
  projectId: z.string().min(1).optional().describe("项目 id（所有 action 必填）"),
  documentId: z.string().min(1).optional().describe("文档 id（documents 之外必填，来自 action=documents）"),
  kind: z
    .enum(ACADEMIC_DOCUMENT_KINDS)
    .optional()
    .describe("文档类型（create_document 可选，缺省 draft：proposal 开题报告 / plan 研究计划 / draft 初稿 / revision 修改稿 / cover_letter 投稿信 / custom 自定义）"),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("文档标题（create_document 必填）或章节标题（save 必填）"),
  sections: z
    .array(outlineSectionSchema)
    .min(1)
    .max(30)
    .optional()
    .describe("章节列表（create_document 可选，缺省为论文标准六章；outline_update 必填）"),
  key: z
    .string()
    .regex(/^[a-z0-9-_]+$/, "章节 key 只能包含小写字母、数字、- 和 _")
    .max(50)
    .optional()
    .describe("章节 key（read 必填；save/outline_update 可选，缺省按标题生成）"),
  content: z.string().min(1).optional().describe("章节正文（save 必填）"),
  uploadUuid: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("项目云盘文件的 upload_uuid（import_docx；与 sessionDocument 二选一；可用 research_workspace(action=list_files) 或项目文件列表获取）"),
  sessionDocument: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("本会话上传的 Word：文件名或会话文档 id（import_docx；与 uploadUuid 二选一）。用户随对话上传的文档无需再传到云盘，原件可直接作为模板导入"),
}).superRefine((args, ctx) => {
  // Every action operates on a project, but keeping projectId optional lets the
  // tool return Chinese guidance in direct calls; schema-level validation gives
  // the model an immediate, actionable error instead of a narrated retry loop.
  if (!args.projectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "缺少 projectId（所有 academic_manuscript action 都需要项目 id；可用 academic_project(action=list) 查看）",
    });
  }
});

/**
 * Build the academic_manuscript tool.
 *
 * Actions: create_document / documents / list / read / save / outline_update /
 * export_markdown / export_latex / export_docx / import_docx. Returns Chinese
 * text for the ReAct loop plus an academic_manuscript artifact for the web
 * client; text exports never touch the filesystem, while export_docx /
 * import_docx delegate the render + cloud round-trip to ManuscriptDocxService.
 * export_docx additionally returns a kind="file" card so the exported Word shows
 * up as a downloadable file next to the manuscript JSON artifact.
 *
 * Side effects: document/section upserts and project event appends. Expected
 * failures (unknown document, missing project, bad key) are answered as
 * guidance text instead of thrown, so a bad argument does not abort the loop.
 */
export function createAcademicManuscriptTool(deps: AcademicManuscriptToolDeps) {
  /**
   * Load a document and enforce double scoping: the repository already filters
   * by uid, and the projectId check prevents a valid document id from another
   * project being reached through this project context.
   */
  async function loadDocument(
    uid: string,
    projectId: string,
    documentId: string,
  ): Promise<AcademicDocument | null> {
    const doc = await deps.documents.getDocument(uid, documentId);
    if (!doc || doc.projectId !== projectId) return null;
    return doc;
  }

  /** Conversation-uploaded documents of the current turn (empty outside a chat session). */
  async function listSessionDocs(ctx: ToolRunContext): Promise<SessionDocumentMeta[]> {
    const sessionId = ctx.chatSessionId;
    if (!sessionId || !deps.sessionDocs) return [];
    return deps.sessionDocs.list(sessionId).catch(() => []);
  }

  /** One-line hint listing this conversation's Word uploads ("" when none). */
  async function sessionDocxHint(ctx: ToolRunContext): Promise<string> {
    const docs = (await listSessionDocs(ctx)).filter((doc) => isDocxFile(doc.filename, doc.contentType));
    if (docs.length === 0) return "";
    return (
      "\n本会话上传的 Word：" +
      docs.map((doc) => doc.filename + "（id: " + doc.id + "）").join("、") +
      "。"
    );
  }

  /** A conversation upload resolved to original bytes, or guidance text explaining why not. */
  type SessionDocx = { bytes: Uint8Array; fileName: string; mimeType?: string } | { error: string };

  /**
   * Resolves sessionDocument (document id or filename) to the ORIGINAL .docx
   * bytes kept by attachment storage at upload time. Failures are guidance, not
   * throws: the ReAct loop learns whether the original was never kept
   * (non-durable storage / legacy row) or the object is gone.
   */
  async function resolveSessionDocx(ctx: ToolRunContext, wanted: string): Promise<SessionDocx> {
    const sessionId = ctx.chatSessionId;
    if (!sessionId) return { error: "当前对话没有会话 id，无法读取会话上传的文档。" };
    if (!deps.sessionDocs || !deps.sessionFiles) {
      return {
        error: "会话文档读取未启用（附件存储不可用）；请改用 uploadUuid 从项目云盘导入，或在写作页「导入 Word」重新上传。",
      };
    }
    const docs = await deps.sessionDocs.list(sessionId).catch(() => []);
    if (docs.length === 0) {
      return { error: "本会话没有上传过文档；请先在对话里上传 Word，或在写作页用「导入 Word」上传。" };
    }
    // Exact id wins, then exact filename, then case-insensitive filename.
    const match =
      docs.find((doc) => doc.id === wanted) ??
      docs.find((doc) => doc.filename === wanted) ??
      docs.find((doc) => doc.filename.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      return {
        error:
          "本会话没有名为「" + wanted + "」的文档。本会话文档：" +
          docs.map((doc) => doc.filename + "（id: " + doc.id + "）").join("、") + "。",
      };
    }
    if (!isDocxFile(match.filename, match.contentType)) {
      return { error: "「" + match.filename + "」不是 .docx 文件，不能作为 Word 模板导入。" };
    }
    if (!match.key) {
      return {
        error:
          "「" + match.filename + "」的原件没有留存（上传时附件存储未启用，或是旧数据），拿不到原始文件；" +
          "请在写作页用「导入 Word」重新上传一次，或以 projectId + uploadUuid 导入项目云盘里的 Word。",
      };
    }
    const bytes = await deps.sessionFiles.getBytes(match.key).catch(() => undefined);
    if (!bytes || bytes.byteLength === 0) {
      return { error: "读取会话文档原件失败（对象存储不可用或文件已清理）；请在写作页用「导入 Word」重新上传。" };
    }
    return { bytes, fileName: match.filename, ...(match.contentType ? { mimeType: match.contentType } : {}) };
  }

  return defineTool({
    name: "academic_manuscript",
    description:
      "学术稿件写作（按章节保存，可导出）。" +
      "action=create_document：新建写作文档（kind：proposal 开题报告 / plan 研究计划 / draft 初稿 / revision 修改稿 / cover_letter 投稿信 / custom 自定义；不传 sections 时默认「摘要/引言/相关工作/方法/实验/结论」六章）；" +
      "action=documents：列出项目文档（document_id/类型/标题/章节数/字数）；" +
      "action=list：列出文档章节；action=read：读取某章节正文（需要 key）；" +
      "action=save：写入或更新章节（title + content，key 省略时按标题生成/匹配）；" +
      "action=outline_update：重排/改名/新增章节（不覆盖已有正文）；" +
      "action=export_markdown / export_latex：拼接导出全文文本（不落盘）；" +
      "action=export_docx：生成 Word（有原始上传稿时保留其样式/页面设置）并回存到项目云盘 05_论文，返回文件名与 uploadUuid（用户可在写作页下载）；" +
      "action=import_docx：把已有 .docx 导入为写作文档，该文件同时作为后续导出的样式模板；uploadUuid 指项目云盘文件（不重复上传），sessionDocument 指本会话上传的 Word（文件名或会话文档 id，原件在附件存储里，" +
      "用户无需再上传一次；只有该会话文档原件未留存时才需要重新上传）；" +
      "纪律：正文内容必须基于用户提供的材料与真实检索结果；不得编造实验数据、统计结果或审稿意见。",
    inputSchema: manuscriptInputSchema,
    async execute(args, ctx) {
      const uid = ctx.uid;
      if (!uid) return NO_USER_TEXT;
      const projectId = args.projectId?.trim() ?? "";
      if (!projectId) return MISSING_PROJECT_TEXT;
      const project = await deps.projects.get(uid, projectId);
      if (!project) return NO_PROJECT_TEXT;
      const documentId = args.documentId?.trim() ?? "";

      switch (args.action) {
        case "create_document": {
          const title = (args.title ?? "").trim();
          if (!title) return "create_document 需要 title：给文档一个标题（如「投稿初稿」）。";
          const kind: AcademicDocumentKind = args.kind ?? "draft";
          let sectionInputs: AcademicSectionInput[];
          if (args.sections && args.sections.length > 0) {
            // Key resolution: explicit key, then slug of the title, then a positional fallback - every section stays addressable even without a caller-supplied key.
            sectionInputs = args.sections.map((section, index) => {
              const input: AcademicSectionInput = {
                key: section.key?.trim() || slugKey(section.title) || "section-" + (index + 1),
                title: section.title,
                content: section.content ?? "",
                order: section.order ?? index,
              };
              return input;
            });
          } else {
            // Clone the defaults; each document owns its own sections array.
            sectionInputs = defaultManuscriptSections();
          }
          const doc = await deps.documents.createDocument(uid, projectId, {
            kind,
            title,
            sections: sectionInputs,
          });
          await deps.events.append(
            uid,
            projectId,
            "manuscript.document_created",
            { documentId: doc.id, kind, title: doc.title, sectionCount: doc.sections.length },
            "agent",
          );
          pushManuscriptArtifact(ctx, { action: "create_document", projectId, document: doc });
          return (
            "已创建写作文档《" +
            doc.title +
            "》（document_id: " +
            doc.id +
            "，类型：" +
            (ACADEMIC_DOCUMENT_KIND_LABELS[kind] ?? kind) +
            "，章节 " +
            doc.sections.length +
            " 个）。\n" +
            renderSections(doc) +
            "\n\n下一步：用 action=save（documentId + title + content）写入章节正文。"
          );
        }

        case "documents": {
          const docs = await deps.documents.listDocuments(uid, projectId);
          if (docs.length === 0) {
            return "项目还没有写作文档。可用 action=create_document 新建（缺省为论文标准六章）。";
          }
          const lines = ["项目「" + project.title + "」共有 " + docs.length + " 个写作文档："];
          docs.forEach((doc, index) => {
            lines.push(
              (index + 1) +
                ". [" +
                doc.id +
                "] 《" +
                doc.title +
                "》｜类型：" +
                (ACADEMIC_DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind) +
                "｜章节 " +
                doc.sections.length +
                "｜" +
                documentWordCount(doc) +
                " 字｜更新 " +
                dateOf(doc.updatedAt),
            );
          });
          lines.push("用 action=list / read + documentId 查看章节，action=save 写入章节。");
          pushManuscriptArtifact(ctx, {
            action: "documents",
            projectId,
            documents: docs.map((doc) => ({
              id: doc.id,
              kind: doc.kind,
              title: doc.title,
              sectionCount: doc.sections.length,
              wordCount: documentWordCount(doc),
              updatedAt: doc.updatedAt,
            })),
          });
          return lines.join("\n");
        }

        case "list": {
          if (!documentId) return "list 需要 documentId：先 action=documents 查看文档 id。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;
          pushManuscriptArtifact(ctx, { action: "list", projectId, documentId, document: doc });
          return (
            "文档《" +
            doc.title +
            "》（document_id: " +
            doc.id +
            "，类型：" +
            (ACADEMIC_DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind) +
            "，共 " +
            doc.sections.length +
            " 章、" +
            documentWordCount(doc) +
            " 字）：\n" +
            renderSections(doc)
          );
        }

        case "read": {
          if (!documentId) return "read 需要 documentId：先 action=documents 查看文档 id。";
          const key = (args.key ?? "").trim();
          if (!key) return "read 需要 key：指明要读取的章节 key（先用 action=list 查看）。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;
          const section = doc.sections.find((candidate) => candidate.key === key);
          if (!section) {
            return (
              "文档《" +
              doc.title +
              "》里没有章节 key=「" +
              key +
              "」。现有章节：" +
              doc.sections.map((candidate) => candidate.key).join("、")
            );
          }
          pushManuscriptArtifact(ctx, { action: "read", projectId, documentId, section });
          const body = section.content.trim();
          return (
            "【" +
            section.title +
            "】（key: " +
            section.key +
            "，" +
            wordCount(section.content) +
            " 字）\n\n" +
            (body.length > 0 ? body : "（本章节还没有正文）")
          );
        }

        case "save": {
          if (!documentId) return "save 需要 documentId：先 action=documents 查看文档 id。";
          const title = (args.title ?? "").trim();
          if (!title) return "save 需要 title：章节标题（如「方法」）。";
          const content = args.content ?? "";
          if (!content.trim()) return "save 需要 content：章节正文不能为空。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;

          // Resolve the target section: explicit key wins, otherwise match by title (re-saving a renamed heading updates the same section), then derive a new key.
          const providedKey = (args.key ?? "").trim();
          const existing = providedKey
            ? doc.sections.find((section) => section.key === providedKey)
            : doc.sections.find((section) => section.title === title);
          const key = providedKey || existing?.key || slugKey(title) || "section-" + (doc.sections.length + 1);
          // Keep an existing position on update; new sections append to the end.
          const order = existing?.order ?? doc.sections.length;
          const updated = await deps.documents.upsertSection(uid, documentId, {
            key,
            title,
            content,
            order,
          });
          if (!updated) return NO_DOCUMENT_TEXT;
          const words = wordCount(content);
          await deps.events.append(
            uid,
            projectId,
            "manuscript.section_saved",
            { documentId, key, title, wordCount: words },
            "agent",
          );
          pushManuscriptArtifact(ctx, { action: "save", projectId, documentId, document: updated });
          return (
            "已保存章节「" +
            title +
            "」（key: " +
            key +
            "，" +
            words +
            " 字）。文档《" +
            updated.title +
            "》现共 " +
            updated.sections.length +
            " 章、" +
            documentWordCount(updated) +
            " 字。\n" +
            renderSections(updated)
          );
        }

        case "outline_update": {
          if (!documentId) return "outline_update 需要 documentId：先 action=documents 查看文档 id。";
          const items = args.sections ?? [];
          if (items.length === 0) return "outline_update 需要 sections：给出新的章节顺序与标题。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;

          const existingByKey = new Map(doc.sections.map((section) => [section.key, section] as const));
          const used = new Set(doc.sections.map((section) => section.key));
          let current = doc;
          let cursor = 0;
          // Walk the requested outline in order and upsert one section at a time; cursor tracks the running order when an item omits one.
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const title = item.title.trim();
            let key = item.key?.trim() ?? "";
            // Derive keys for new sections and de-collide with a numeric suffix; an existing key with the same title is the same section, so its key/position are reused.
            if (!key) {
              const base = slugKey(title) || "section-" + (index + 1);
              key = base;
              const clash = existingByKey.get(key);
              if (used.has(key) && (!clash || clash.title !== title)) {
                let suffix = 2;
                while (used.has(base + "-" + suffix)) suffix += 1;
                key = base + "-" + suffix;
              }
            }
            const existing = existingByKey.get(key);
            const order = item.order ?? cursor;
            cursor = order + 1;
            const input: AcademicSectionInput = { key, title, order };
            // Existing body text is preserved on outline changes: this action reorganizes structure, it never rewrites content.
            input.content = existing ? existing.content : (item.content ?? "");
            // Upsert per item; the last successful result is the freshest document snapshot returned to the caller.
            const result = await deps.documents.upsertSection(uid, documentId, input);
            if (result) current = result;
            used.add(key);
            existingByKey.set(key, {
              key,
              title,
              content: existing?.content ?? "",
              order,
              updatedAt: Date.now(),
            });
          }
          await deps.events.append(
            uid,
            projectId,
            "manuscript.outline_updated",
            { documentId, sectionCount: current.sections.length },
            "agent",
          );
          pushManuscriptArtifact(ctx, { action: "outline_update", projectId, documentId, document: current });
          return (
            "已更新章节结构（" +
            current.sections.length +
            " 章，已有正文未被覆盖）。\n" +
            renderSections(current) +
            "\n提示：调整后可 action=export_markdown / export_latex 导出。"
          );
        }

        case "export_markdown": {
          if (!documentId) return "export_markdown 需要 documentId：先 action=documents 查看文档 id。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;
          const markdown = toMarkdown(doc);
          pushManuscriptArtifact(ctx, {
            action: "export_markdown",
            projectId,
            documentId,
            title: doc.title,
            content: markdown,
          });
          return markdown;
        }

        case "export_latex": {
          if (!documentId) return "export_latex 需要 documentId：先 action=documents 查看文档 id。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;
          const latex = toLatex(doc);
          pushManuscriptArtifact(ctx, {
            action: "export_latex",
            projectId,
            documentId,
            title: doc.title,
            content: latex,
          });
          return latex;
        }

        case "export_docx": {
          if (!documentId) return "export_docx 需要 documentId：先 action=documents 查看文档 id。";
          const doc = await loadDocument(uid, projectId, documentId);
          if (!doc) return NO_DOCUMENT_TEXT;
          if (!deps.docx) {
            return "Word 导出服务未启用（云盘未配置），暂时无法回存 Word；可先用 action=export_markdown / export_latex 导出文本。";
          }
          try {
            const exported = await deps.docx.exportDocxToCloud(uid, documentId);
            pushManuscriptArtifact(ctx, {
              action: "export_docx",
              projectId,
              documentId,
              title: doc.title,
              export: exported,
            });
            const content =
              "已生成 Word 并回存到项目云盘 05_论文：" +
              exported.fileName +
              "（uploadUuid: " +
              exported.uploadUuid +
              "，目录 folderId: " +
              exported.folderId +
              "）。\n可在写作页（写作 Tab）下载或继续修改；" +
              "如只想要文本，仍可用 action=export_markdown / export_latex。";
            // The exported Word is also a file card: the web client renders it as a
            // downloadable file (cloud-drive deep link) next to the manuscript JSON.
            const fileArtifact = buildFileArtifact({
              name: exported.fileName,
              description: "已回存到项目云盘 05_论文，可在写作页或云盘下载",
              action: "exported",
              uploadUuid: exported.uploadUuid,
              mime: DOCX_MIME,
            });
            return fileArtifact.ok ? { content, artifacts: [fileArtifact.artifact] } : content;
          } catch (err) {
            // Expected domain failures (404/503) become guidance text so the ReAct
            // loop can recover instead of aborting the whole turn.
            if (err instanceof AcademicError) return "Word 导出失败：" + err.message;
            throw err;
          }
        }

        case "import_docx": {
          const uploadUuid = (args.uploadUuid ?? "").trim();
          const sessionDocument = (args.sessionDocument ?? "").trim();
          if (!uploadUuid && !sessionDocument) {
            return (
              "import_docx 需要 uploadUuid（项目云盘文件）或 sessionDocument（本会话上传的 Word 文件名/文档 id）。" +
              (await sessionDocxHint(ctx))
            );
          }
          const docx = deps.docx;
          if (!docx) {
            return "Word 导入服务未启用（云盘未配置），暂时无法把 Word 导入为写作文档。";
          }
          try {
            let imported: Awaited<ReturnType<ManuscriptDocxService["importDocx"]>>;
            if (uploadUuid) {
              imported = await docx.importDocxFromCloud(uid, projectId, {
                uploadUuid,
                ...(args.title ? { title: args.title } : {}),
                ...(args.kind ? { kind: args.kind } : {}),
              });
            } else {
              // Conversation upload → same import path: the original binary is
              // copied into the project cloud drive and becomes the export template.
              const resolved = await resolveSessionDocx(ctx, sessionDocument);
              if ("error" in resolved) return "Word 导入失败：" + resolved.error;
              imported = await docx.importDocx(uid, projectId, {
                fileName: resolved.fileName,
                mimeType: resolved.mimeType ?? DOCX_MIME,
                bytes: resolved.bytes,
                ...(args.title ? { title: args.title } : {}),
                ...(args.kind ? { kind: args.kind } : {}),
              });
            }
            const importedDoc = imported.document;
            await deps.events.append(
              uid,
              projectId,
              "manuscript.document_imported",
              {
                documentId: importedDoc.id,
                uploadUuid: imported.source.uploadUuid,
                title: importedDoc.title,
                sectionCount: importedDoc.sections.length,
              },
              "agent",
            );
            pushManuscriptArtifact(ctx, {
              action: "import_docx",
              projectId,
              document: importedDoc,
              source: imported.source,
            });
            return (
              "已从" +
              (uploadUuid ? "项目云盘" : "本会话上传") +
              "导入 Word 模板《" +
              importedDoc.title +
              "》（document_id: " +
              importedDoc.id +
              "，类型：" +
              (ACADEMIC_DOCUMENT_KIND_LABELS[importedDoc.kind] ?? importedDoc.kind) +
              "，章节 " +
              importedDoc.sections.length +
              " 个，来源文件：" +
              imported.source.fileName +
              "，uploadUuid: " +
              imported.source.uploadUuid +
              "）。\n" +
              renderSections(importedDoc) +
              "\n\n后续 action=export_docx 会以该云盘文件为模板保留其样式/页面设置；可先用 action=save 写入各章节正文。" +
              "\n如需按原模板还原字号/页边距/表格合并等版式细节，可调用 docx_inspect（uploadUuid: " +
              imported.source.uploadUuid +
              "）。"
            );
          } catch (err) {
            // Expected domain failures (404/422/503) become guidance text so the
            // ReAct loop can recover instead of aborting the whole turn.
            if (err instanceof AcademicError) return "Word 导入失败：" + err.message;
            throw err;
          }
        }

        // Unreachable through zod validation, but older/unknown clients still get guidance instead of a throw.
        default: {
          const action = String((args as { action?: unknown }).action ?? "");
          return (
            "未知 action：" +
            action +
            "（可用：create_document / documents / list / read / save / outline_update / export_markdown / export_latex / export_docx / import_docx）"
          );
        }
      }
    },
  });
}
