import { z } from "zod";

import { buildFileArtifact } from "../../artifacts/file.js";
import { renderStructuralAudit } from "../../services/office/qa-structural.js";
import type { Artifact } from "../../context/types.js";
import type { QuotaKind } from "../../services/quota.js";
import { OFFICE_MIME, OfficeExportService, type OfficeTemplatePort } from "../../services/office/index.js";
import { OFFICE_LIMITS, type DocxBlock } from "../../services/office/types.js";
import { OfficeExportError } from "../../services/office/errors.js";
import { defineTool } from "../base.js";

/**
 * office_export: the single tool behind "write me a Word / Excel / PPT file".
 *
 * One tool instead of three keeps the agent's tool list (and its prompt budget)
 * small: the format selects the content branch, and every branch is a compact,
 * declarative model the model can fill without knowing OOXML. The heavy lifting
 * (package authoring, size ceiling, cloud upload) lives in services/office/*;
 * this file only validates the request and turns the result into a file card +
 * guidance text.
 *
 * Identity never rides in the schema: uid comes from ToolRunContext, so the model
 * cannot export into someone else's cloud drive.
 */

const cellSchema = z
  .union([z.string().max(2000), z.number(), z.boolean(), z.null()])
  .describe("单元格：数字请用 number（才能参与公式/统计），文本用 string，以 = 开头的字符串会写成公式");

const docxBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    text: z.string().min(1).max(300).describe("标题文字：一级用「一、」，二级用「（一）」，三级用「1.」；不要带 Markdown 的 # 或 *"),
    level: z.number().int().min(1).max(3).optional().describe("层级：1/2/3，默认 1"),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: z.string().min(1).max(OFFICE_LIMITS.textChars).describe("正文段落：正式书面语，3-6 句一段，先结论后依据；支持 **加粗**、*斜体*、反引号代码"),
  }),
  z.object({
    type: z.literal("line"),
    text: z.string().min(1).max(500).describe("无首行缩进的短行，用于信息行（如「姓名：张伟　性别：男　出生年月：1998.06」）"),
  }),
  z.object({
    type: z.literal("bullets"),
    items: z.array(z.string().min(1).max(1000)).min(1).max(100).describe("列表项"),
    ordered: z.boolean().optional().describe("true = 有序列表（1. 2. 3.），默认无序圆点"),
  }),
  z.object({ type: z.literal("quote"), text: z.string().min(1).max(2000).describe("引用/提示块") }),
  z.object({
    type: z.literal("table"),
    headers: z.array(z.string().max(200)).max(10).optional().describe("表头（可选）"),
    rows: z
      .array(z.array(z.union([z.string().max(2000), z.number()])).max(10))
      .min(1)
      .max(OFFICE_LIMITS.docxTableRows)
      .describe("数据行；每行列数应与表头一致"),
    caption: z.string().max(200).optional().describe("表题（如「表 1 核心指标」），数据表建议都写"),
    widths: z.array(z.number().positive()).max(10).optional().describe("列宽相对比例，如 [1,2,2]；省略则均分"),
  }),
  z.object({ type: z.literal("pageBreak") }),
]);

const xlsxSheetSchema = z.object({
  name: z.string().min(1).max(31).describe("工作表名（Excel 上限 31 字符）"),
  title: z
    .string()
    .max(200)
    .optional()
    .describe("表格上方的大标题行（跨列合并，占用第 1 行；有 title 时表头在第 2 行、数据从第 3 行开始）"),
  headers: z.array(z.string().max(200)).max(OFFICE_LIMITS.xlsxCols).optional().describe("表头行"),
  rows: z
    .array(z.array(cellSchema).max(OFFICE_LIMITS.xlsxCols))
    .min(1)
    .max(OFFICE_LIMITS.xlsxRows)
    .describe("数据行"),
  widths: z.array(z.number().min(6).max(80)).max(OFFICE_LIMITS.xlsxCols).optional().describe("列宽（字符宽），省略按内容估算"),
  freezeHeader: z.boolean().optional().describe("冻结表头（有表头时默认冻结）"),
  autoFilter: z.boolean().optional().describe("表头加筛选（有表头时默认开启）"),
  totalRow: z.boolean().optional().describe("最后一行加粗作为合计行"),
});

const pptxSlideSchema = z.object({
  title: z.string().min(1).max(200).describe("页面标题"),
  subtitle: z.string().max(300).optional().describe("封面/章节页的副标题"),
  bullets: z.array(z.string().min(1).max(500)).max(OFFICE_LIMITS.pptxBullets).optional().describe("要点（每页 ≤14 条）"),
  paragraphs: z.array(z.string().min(1).max(800)).max(8).optional().describe("无项目符号的正文段（放在要点上方）"),
  table: z
    .object({
      headers: z.array(z.string().max(100)).max(8).optional(),
      rows: z.array(z.array(z.string().max(300)).max(8)).min(1).max(OFFICE_LIMITS.pptxTableRows),
      widths: z.array(z.number().positive()).max(8).optional(),
    })
    .optional()
    .describe("页内数据表（与 bullets 可同时用，表格排在正文下方）"),
  kind: z
    .enum(["title", "section", "content", "table"])
    .optional()
    .describe("版式：title=封面 / section=章节隔页 / content=要点页 / table=表格页；省略按内容推断（首页自动封面）"),
});

const inputSchema = z
  .object({
    format: z.enum(["docx", "xlsx", "pptx"]).describe("docx=Word 文档 / xlsx=Excel 表格 / pptx=PPT 演示文稿"),
    title: z.string().min(1).max(120).describe("文档标题，同时作为文件名：简洁正式、不超过 25 字，不用「关于……的说明」这类空话"),
    docx: z
      .object({ blocks: z.array(docxBlockSchema).min(1).max(OFFICE_LIMITS.docxBlocks).describe("按顺序排列的内容块") })
      .optional()
      .describe("format=docx 时必填"),
    xlsx: z
      .object({ sheets: z.array(xlsxSheetSchema).min(1).max(OFFICE_LIMITS.xlsxSheets).describe("工作表列表") })
      .optional()
      .describe("format=xlsx 时必填"),
    pptx: z
      .object({
        slides: z.array(pptxSlideSchema).min(1).max(OFFICE_LIMITS.pptxSlides).describe("幻灯片列表（第 1 页默认封面）"),
        footer: z.string().max(120).optional().describe("页脚小字（如项目名/团队名）"),
      })
      .optional()
      .describe("format=pptx 时必填"),
    revisionOf: z
      .string()
      .min(16)
      .max(128)
      .optional()
      .describe("修改已有文档时必填：填上次返回的 uploadUuid，工具会覆盖该文件内容（同一文件迭代，不新建文件，uploadUuid 不变）。仅当用户要求修改/润色此前生成的文档时使用"),
    templateUploadUuid: z
      .string()
      .min(16)
      .max(128)
      .optional()
      .describe("可选：format=docx 时用云盘里的 .docx（uploadUuid）作为样式模板，保留其字体/页眉页脚/页面设置"),
    folderPath: z
      .string()
      .max(200)
      .optional()
      .describe("保存位置：云盘 agent/ 下的子目录（如 \"2026Q3\" 或 \"2026Q3/周报\"，最多 6 层）；省略 = agent/ 根目录"),

    folderId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("保存位置：直接指定已有云盘文件夹 id（优先于 folderPath；可用 cloud 工具或文件列表获得）"),
  })
  .superRefine((args, ctx) => {
    // Required branch is contextual (one tool, three formats), so a missing
    // branch must fail here with an actionable message instead of a type error.
    const branch = args.format === "docx" ? args.docx : args.format === "xlsx" ? args.xlsx : args.pptx;
    if (!branch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          args.format === "docx"
            ? "format=docx 需要提供 docx.blocks（标题/段落/表格等内容块）"
            : args.format === "xlsx"
              ? "format=xlsx 需要提供 xlsx.sheets（每个工作表一张表）"
              : "format=pptx 需要提供 pptx.slides（每页一张幻灯片）",
      });
    }
    if (args.templateUploadUuid && args.format !== "docx") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "templateUploadUuid 只支持 docx（PPT 模板暂不支持）" });
    }
  });

type OfficeExportInput = z.infer<typeof inputSchema>;

export interface OfficeExportToolDeps {
  service: OfficeExportService;
  /** Template download port (cloud drive); omitted = template feature unavailable. */
  templates?: OfficeTemplatePort;
  /** Optional member quota gate (one consume per exported file). */
  quota?: { consumeKind(uid: string, kind: QuotaKind, n?: number): Promise<boolean> };
}

function describeSpec(args: OfficeExportInput): string {
  if (args.format === "docx") {
    const blocks = args.docx?.blocks ?? [];
    const tables = blocks.filter((block) => block.type === "table").length;
    const headings = blocks.filter((block) => block.type === "heading").length;
    return "内容块 " + blocks.length + " 个（标题 " + headings + "、表格 " + tables + "）";
  }
  if (args.format === "xlsx") {
    const sheets = args.xlsx?.sheets ?? [];
    const rows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
    return "工作表 " + sheets.length + " 张、数据行 " + rows + " 行";
  }
  const slides = args.pptx?.slides ?? [];
  return "幻灯片 " + slides.length + " 页";
}

/**
 * Narrows the schema output into the builders' model: zod allows level 1..3 as
 * a plain number and table cells as string|number, while the builders want the
 * literal union and strings. Keeping the cast here (not in the builder) means a
 * future schema change fails at one visible place.
 */
function toDocxBlocks(input: NonNullable<OfficeExportInput["docx"]>): DocxBlock[] {
  return input.blocks.map<DocxBlock>((block) => {
    switch (block.type) {
      case "heading":
        return { type: "heading", text: block.text, level: block.level === 3 ? 3 : block.level === 2 ? 2 : 1 };
      case "table":
        return {
          type: "table",
          ...(block.headers ? { headers: block.headers } : {}),
          rows: block.rows.map((row) => row.map((cell) => String(cell))),
          ...(block.caption ? { caption: block.caption } : {}),
          ...(block.widths ? { widths: block.widths } : {}),
        };
      default:
        return block as DocxBlock;
    }
  });
}

const FORMAT_LABEL = { docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示文稿" } as const;

export function createOfficeExportTool(deps: OfficeExportToolDeps) {
  return defineTool({
    name: "office_export",
    description:
      "生成并保存 Office 文件到用户云盘（docx=Word、xlsx=Excel、pptx=PPT，一次只生成一种）。当用户要「写成一份文档/报告/方案/通知」「导出成 Word」「做成表格或演示文稿」时调用。内容必须来自对话上下文、检索结果或用户材料，不得编造数据、日期、人名或结论。" +
      "【迭代规则（重要）】首次生成才新建文件；用户要求修改/润色/调整此前生成的文档时，必须传 revisionOf=上次返回的 uploadUuid，覆盖同一文件（不新建、不带新时间戳）。历史消息里的文件卡片与云盘链接会指向同一文件的最新版本。" +
      "【Word 版式：先选模板，再用模块搭】docx.layout 决定页边距/字体/标题层级/色彩（模板已内置，禁止用空行、全角空格或「——」自己凑版式，也不要写 Markdown 的 #、*、-）：" +
      "report=报告/复盘（默认，含封面位）；proposal=方案/计划（封面+对比表+步骤）；resume=简历（不用封面，紧凑字号与窄边距）；brief=通知/简报（一页以内）。" +
      "必须用模块而不是只堆段落，每个一级标题下至少一个结构化块：" +
      "cover=封面（title/subtitle/meta，报告/方案放第一位）；kv=基本信息网格（label/value，columns=2 两列并排）；" +
      "metrics=关键数字卡片（2-4 个，value 简短如「1,200 万元」「+18%」，note 写口径/同比）；" +
      "callout=结论/风险/提示框（tone=info/warning/success）；table=数据表（表头 + 2-4 列 + caption 表题，列宽默认按内容自动估算）；" +
      "bullets=要点；line=无缩进信息行；divider=分隔线；pageBreak=分页。" +
      "段落只用于解释与过渡（3-6 句一段，先结论后依据），数据必须进 table 或 metrics，正文不要复述表格数字。" +
      "【内容质量】客观克制：禁止「作为 AI」「首先/其次/最后」「综上所述」「总而言之」「希望对你有帮助」「让我们一起」等套话，禁止 emoji、感叹号堆砌、空泛排比与「以下是/本文将」这类元叙述；" +
      "不得出现 XX/待补充/TBD 占位符（信息不足就省略该部分）；标题精炼不超过 25 字，不用「关于……的说明」。" +
      "【简历专项】education/experience 用一行 line（如「2022.09–2026.06　xx大学　计算机科学与技术　本科」），下面用 bullets 写 2-3 条带数字的成果；" +
      "技能用 line 或 bullets；全文 1-2 页，不要四列「项目/内容」对照表，也不要给每个字段单独设标题。" +
      "xlsx 每张表给 name + headers + rows，数字用 number，需要计算时把公式写成 =SUM(B2:B9) 这类字符串（按最终表格位置书写：有 title 时表头在第 2 行、数据从第 3 行开始；公式单元格显示常规格式），可开 freezeHeader/autoFilter/totalRow；" +
      "pptx 每页给 title + bullets（≤14 条）或 table，首页自动作为封面，可用 kind 指定 section（章节隔页）/" +
      "table（表格页）。不支持：图片/视频、Excel 图表、PPT 演讲者备注、PPT 模板套用（需要图表请用 render_chart 生成交互图表）。" +
      "文件默认保存到用户云盘的 agent/ 目录（注册时创建、缺失自动补建），可用 folderPath 指定其下子目录（如 2026Q3/周报）或 folderId 指定已有文件夹；返回 uploadUuid，前端显示下载卡片。" +
      "文件默认保存到用户云盘的 agent/ 目录（缺失自动补建），可用 folderPath/folderId 指定位置；返回 uploadUuid，前端会显示下载卡片与 Word 文档预览。" +
      "回复只说明生成了什么、结构要点、存在哪个目录，不要整篇复述。",
    inputSchema,
    async execute(args, ctx) {
      const uid = ctx.uid;
      if (!uid) return "生成文件需要登录用户身份，当前会话没有用户信息。";
      if (!args.revisionOf && deps.quota && !(await deps.quota.consumeKind(uid, "office_export"))) {
        return "本次导出超出当前额度（Office 导出按次计量）。可以稍后再试，或先减少导出次数（一次导出多个文档时合并成一个文件）。";
      }

      // Optional docx template: the download is best-effort — failing it must not
      // block the export, the model just gets told the layout fell back to default.
      let template: Uint8Array | undefined;
      let templateNote = "";
      if (args.format === "docx" && args.templateUploadUuid) {
        if (!deps.templates) {
          templateNote = "（模板功能需要云盘支持，本次已按默认排版生成）";
        } else {
          try {
            const file = await deps.templates.downloadFile(uid, args.templateUploadUuid);
            template = file.data;
          } catch (err) {
            templateNote =
              "（模板读取失败，已按默认排版生成：" + (err instanceof Error ? err.message : String(err)) + "）";
          }
        }
      }

      const spec = {
        format: args.format,
        title: args.title,
        ...(args.docx ? { docx: { blocks: toDocxBlocks(args.docx) } } : {}),
        ...(args.xlsx ? { xlsx: args.xlsx } : {}),
        ...(args.pptx ? { pptx: args.pptx } : {}),
        ...(args.folderPath ? { folderPath: args.folderPath } : {}),
        ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
        ...(args.revisionOf ? { revisionOf: args.revisionOf } : {}),
      };

      let exported: Awaited<ReturnType<OfficeExportService["export"]>>;
      try {
        exported = await deps.service.export(uid, spec, template ? { template } : {});
      } catch (err) {
        if (err instanceof OfficeExportError) {
          // Domain failures are guidance, not crashes: the ReAct loop can correct
          // the spec (invalid), shrink it (too_large) or report an outage.
          return "生成失败：" + err.message;
        }
        throw err;
      }

      const sizeKb = Math.max(1, Math.round(exported.size / 1024));
      const audit = deps.service.structureAudit?.(spec);
      const auditNote = audit ? "\n" + renderStructuralAudit(audit) : "";
      const content = args.revisionOf
        ? "已更新同一文件《" + args.title + "》的版本（覆盖原文件，未新建文件）：" + exported.fileName +
          "（" + sizeKb + " KB，" + describeSpec(args) + "；uploadUuid 仍为 " + exported.uploadUuid + "）。" +
          templateNote + auditNote
        : "已生成" + FORMAT_LABEL[exported.format] + "《" +
          args.title + "》并保存到云盘 " + exported.folderLabel + "：" + exported.fileName +
          "（" + sizeKb + " KB，" + describeSpec(args) + "；uploadUuid: " + exported.uploadUuid + "）。" +
          templateNote +
          "\n聊天里只显示可下载的文件卡片；Word 排版可在云盘详情中打开查看；如需修改内容，请调用本工具并传 revisionOf=" + exported.uploadUuid + "（覆盖同一文件，不要新建文件）。" +
          auditNote;

      const artifacts: Artifact[] = [];
      const artifact = buildFileArtifact({
        name: exported.fileName,
        description: "已保存到云盘，可下载",
        action: "exported",
        uploadUuid: exported.uploadUuid,
        mime: OFFICE_MIME[exported.format],
        sizeBytes: exported.size,
      });
      if (artifact.ok) artifacts.push(artifact.artifact);
      return artifacts.length > 0 ? { content, artifacts } : content;
    },
  });
}
