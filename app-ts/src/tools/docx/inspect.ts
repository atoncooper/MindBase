import { z } from "zod";
import { defineTool } from "../base.js";
import { DOCX_DETAIL_FOCUS } from "../../doc-parser/docx-detail.js";
import type { DocxInspectService } from "../../services/docx-inspect.js";

/**
 * docx_inspect: the agent-facing entry of the SECOND Word parsing level.
 *
 * Level 1 (server-side, automatic): manuscript import / section extraction
 * (`parseDocxSections`) reads headings + body text, so ordinary "read this Word"
 * requests never need this tool. Level 2 (this tool): the user asks how the
 * document is FORMATTED — page margins, fonts/sizes, paragraph styles, table
 * merges, headers/footers, core properties — and the service loads the original
 * bytes from the conversation upload or the project cloud drive and renders a
 * Chinese detail summary.
 *
 * The tool only validates arguments (zod) and maps ToolRunContext identity into
 * the service call; all fetch/validation/parse work lives in the service.
 */
export function createDocxInspectTool(service: DocxInspectService) {
  return defineTool({
    name: "docx_inspect",
    description:
      "详细解析 .docx 的版式与结构：页边距/分节、字体字号与段落样式、段落与文字格式、表格结构（跨列/纵向合并/底纹）、页眉页脚、文档属性。" +
      "普通正文读取/切章由服务的一级解析完成（academic_manuscript import_docx 已抽取章节），只想要正文摘要/要点时不要调用本工具；" +
      "当用户要求「按原模板格式还原」「看表格结构」「字体字号」「页眉页脚」「页边距」「样式细节」，或导入 docx 后要复现细节时再调用。" +
      "来源二选一：sessionDocument=本会话上传的 Word（文件名或文档 id），uploadUuid=项目云盘文件 id；focus 可只取需要的部分以减小返回量。" +
      "返回中文文本摘要（≤6000 字），只读、不改动文件。",
    inputSchema: z.object({
      source: z
        .enum(["session", "cloud"])
        .optional()
        .describe("来源：session=本会话上传的 Word，cloud=项目云盘文件；省略时按 sessionDocument/uploadUuid 自动推断"),
      sessionDocument: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe("本会话上传的 Word：文件名或会话文档 id（与 uploadUuid 二选一）"),
      uploadUuid: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("项目云盘文件的 upload_uuid（与 sessionDocument 二选一；可用 research_workspace 或项目文件列表获取）"),
      focus: z
        .array(z.enum(DOCX_DETAIL_FOCUS))
        .min(1)
        .max(DOCX_DETAIL_FOCUS.length)
        .optional()
        .describe(
          "只返回这些部分（默认全部）：page=页边距/纸张/分节，styles=段落样式，fonts=默认字体，" +
            "paragraphs=段落与文字格式，tables=表格合并结构，headers=页眉页脚，metadata=文档属性",
        ),
      maxTables: z.number().int().min(1).max(20).optional().describe("最多展示几个表格（默认 8，上限 20）"),
      maxParagraphs: z.number().int().min(0).max(200).optional().describe("最多展示几段正文（默认 40，上限 200；0=不展示段落）"),
    }).superRefine((args, ctx) => {
      // Required context is contextual, not flat: one source must be present, and
      // an explicit source=... must match its field. This turns a vague "missing
      // argument" retry loop into an immediate, actionable tool error.
      if (!args.sessionDocument && !args.uploadUuid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "需要来源：sessionDocument（本会话上传的 Word，文件名或文档 id）或 uploadUuid（项目云盘文件 id）二选一",
        });
      }
      if (args.source === "session" && !args.sessionDocument) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source=session 时必须提供 sessionDocument" });
      }
      if (args.source === "cloud" && !args.uploadUuid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source=cloud 时必须提供 uploadUuid" });
      }
    }),
    async execute(args, ctx) {
      return service.inspect(
        {
          ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
          ...(ctx.chatSessionId !== undefined ? { chatSessionId: ctx.chatSessionId } : {}),
          ...(args.source !== undefined ? { source: args.source } : {}),
          ...(args.sessionDocument !== undefined ? { sessionDocument: args.sessionDocument } : {}),
          ...(args.uploadUuid !== undefined ? { uploadUuid: args.uploadUuid } : {}),
        },
        {
          ...(args.focus !== undefined ? { focus: args.focus } : {}),
          ...(args.maxTables !== undefined ? { maxTables: args.maxTables } : {}),
          ...(args.maxParagraphs !== undefined ? { maxParagraphs: args.maxParagraphs } : {}),
        },
      );
    },
  });
}
