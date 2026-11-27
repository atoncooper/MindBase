import { z } from "zod";

import type { OfficeDocumentService } from "../../services/office-review.js";
import { defineTool } from "../base.js";

/**
 * Two agent tools around OfficeDocumentService:
 *
 *   office_inspect      -- structure text (docx/xlsx/pptx). Deterministic, cheap,
 *                          no binaries required; answers "what is in this file".
 *   office_visual_check -- render pages + vision critique + page images in the
 *                          transcript. Answers "what does it look like / what is
 *                          wrong", and lets the user SEE the rendered file.
 *
 * They are separate tools because their cost and availability differ: the model
 * should reach for structure first and only pay for rendering when the ask is
 * about layout, or when it must look at the result of a previous export.
 */

const sourceSchema = {
  source: z
    .enum(["session", "cloud"])
    .optional()
    .describe("来源：session=本会话上传的文件，cloud=云盘文件；省略时按 sessionDocument/uploadUuid 自动推断"),
  sessionDocument: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("本会话上传的 .docx/.xlsx/.pptx：文件名或会话文档 id（与 uploadUuid 二选一）"),
  uploadUuid: z
    .string()
    .min(16)
    .max(128)
    .optional()
    .describe("云盘文件的 upload_uuid（与 sessionDocument 二选一；office_export 的返回值里有）"),
};

const inspectSchema = z
  .object({
    ...sourceSchema,
    maxChars: z.number().int().min(500).max(20_000).optional().describe("返回摘要的字数上限（默认 6000）"),
    maxRows: z.number().int().min(1).max(100).optional().describe("Excel 每个工作表最多预览多少行（默认 20）"),
  })
  .superRefine((args, ctx) => {
    if (!args.sessionDocument && !args.uploadUuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需要来源：sessionDocument（本会话上传的文件）或 uploadUuid（云盘文件）二选一",
      });
    }
  });

const visualSchema = z
  .object({
    ...sourceSchema,
    pages: z
      .array(z.number().int().min(1).max(200))
      .min(1)
      .max(8)
      .optional()
      .describe("只渲染这些页码（1 起）；省略=从第 1 页开始渲染 maxPages 页"),
    maxPages: z.number().int().min(1).max(8).optional().describe("最多渲染并展示多少页（默认 6）"),
    focus: z.string().max(300).optional().describe("额外关注点，如「表格是否截断」「中文字体是否过小」"),
  })
  .superRefine((args, ctx) => {
    if (!args.sessionDocument && !args.uploadUuid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需要来源：sessionDocument（本会话上传的文件）或 uploadUuid（云盘文件）二选一",
      });
    }
  });

export function createOfficeInspectTool(documents: OfficeDocumentService) {
  return defineTool({
    name: "office_inspect",
    description:
      "读取 .docx / .xlsx / .pptx 的结构化内容：Word 的标题层级/段落样式/表格合并/页眉页脚，" +
      "Excel 的工作表/行列规模/表头/前若干行/公式/合并单元格/冻结/筛选，" +
      "PPT 的页序/每页标题与文字/表格/形状与图片数量/页面尺寸。" +
      "当用户上传或指向一个 Office 文件，要求「看看里面写了什么 / 按它改 / 提取要点 / 复述结构」时先调用本工具；" +
      "只关心正文文本时也可用 cloud_file_read（云盘文件）或对话里已解析的正文。" +
      "本工具只读、不修改文件；需要判断「版面好不好看/有没有溢出」或想让用户看到页面图时改用 office_visual_check。",
    inputSchema: inspectSchema,
    async execute(args, ctx) {
      return documents.inspect(
        {
          ...(ctx.uid ? { uid: ctx.uid } : {}),
          ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
          ...(args.source ? { source: args.source } : {}),
          ...(args.sessionDocument ? { sessionDocument: args.sessionDocument } : {}),
          ...(args.uploadUuid ? { uploadUuid: args.uploadUuid } : {}),
        },
        {
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
          ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
        },
      );
    },
  });
}

export function createOfficeVisualCheckTool(documents: OfficeDocumentService) {
  return defineTool({
    name: "office_visual_check",
    description:
      "把 Office 文件逐页渲染后交给视觉模型审阅，返回版式问题清单（只给建议，不展示截图）" +
      "（文字溢出/截断/重叠、对齐留白、表格列宽、图片变形、页眉页脚与页码一致性），每条给出「第几页 + 具体怎么改」。" +
      "用于：用户想「看看这个文件长什么样/排版有没有问题」；或你刚用 office_export 生成文件后自检，再按意见修改重生成。" +
      "依赖部署已安装 LibreOffice；不可用时会明确说明并建议改用 office_inspect 看结构文本。" +
      "一次只审一个文件；只看内容结构时不要调用（浪费渲染与视觉额度）。",
    inputSchema: visualSchema,
    async execute(args, ctx) {
      return documents.visualCheck(
        {
          ...(ctx.uid ? { uid: ctx.uid } : {}),
          ...(ctx.chatSessionId ? { chatSessionId: ctx.chatSessionId } : {}),
          ...(args.source ? { source: args.source } : {}),
          ...(args.sessionDocument ? { sessionDocument: args.sessionDocument } : {}),
          ...(args.uploadUuid ? { uploadUuid: args.uploadUuid } : {}),
        },
        {
          ...(args.pages ? { pages: args.pages } : {}),
          ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
          ...(args.focus ? { focus: args.focus } : {}),
        },
      );
    },
  });
}
