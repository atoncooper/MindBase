import { z } from "zod";
import { defineTool } from "../base.js";
import type { McpToolsClient } from "../../mcp/index.js";

/**
 * save_note: saves a markdown note (uid from ToolRunContext). 红线（§2.15）：
 * 笔记落库一律经 app-content-mcp（save_note），本层绝不直连 note 表或任何仓储。
 * 会话笔记语义：target_type="conversation"、target_id=当前会话 id（AGENTS.md
 * 枚举的 conversation 类型）。tags 不再支持——Go app-note 模型无该字段。
 */
export function createSaveNoteTool(client: McpToolsClient) {
  return defineTool({
    name: "save_note",
    description: "把整理好的 markdown 笔记保存到用户的笔记库。保存前先向用户展示笔记内容。",
    inputSchema: z.object({
      title: z.string().min(1).max(120).describe("笔记标题"),
      content: z.string().min(1).max(50_000).describe("完整 markdown 正文"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) {
        return "保存失败：当前会话没有用户身份。";
      }
      if (!ctx.chatSessionId) {
        return "保存失败：当前会话没有会话标识，无法归档会话笔记。";
      }
      const res = await client.callTool(
        "save_note",
        {
          title: args.title,
          target_type: "conversation",
          target_id: ctx.chatSessionId,
          content_md: args.content,
        },
        { uid: ctx.uid },
      );
      if (!res.ok) {
        return `保存失败：${res.error ?? "未知错误"}`;
      }
      return `${res.content}
（${args.content.length} 字符）`;
    },
  });
}

/** list_notes: note metadata only (no body), optionally filtered by target type. */
export function createListNotesTool(client: McpToolsClient) {
  return defineTool({
    name: "list_notes",
    description:
      "列出用户的笔记（仅元数据：标题、uuid、关联对象、更新时间，不含正文）。用于查找要阅读、补全或修改的笔记；拿到 note_uuid 后再用 get_note 读正文。",
    inputSchema: z.object({
      target_type: z
        .enum(["video", "cloud_file"])
        .optional()
        .describe("按关联类型过滤；省略返回全部（含会话笔记）"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) return "读取失败：当前会话没有用户身份。";
      const res = await client.callTool(
        "list_notes",
        args.target_type ? { target_type: args.target_type } : {},
        { uid: ctx.uid },
      );
      if (!res.ok) return `读取失败：${res.error ?? "未知错误"}`;
      return res.content;
    },
  });
}

/** get_note: full Markdown body for one note uuid. */
export function createGetNoteTool(client: McpToolsClient) {
  return defineTool({
    name: "get_note",
    description:
      "读取指定笔记的完整 Markdown 正文。需要 note_uuid（先从 list_notes 获取）。修改笔记前必须先读原文。",
    inputSchema: z.object({
      note_uuid: z.string().min(1).describe("笔记 UUID（来自 list_notes）"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) return "读取失败：当前会话没有用户身份。";
      const res = await client.callTool("get_note", { note_uuid: args.note_uuid }, { uid: ctx.uid });
      if (!res.ok) return `读取失败：${res.error ?? "未知错误"}`;
      return res.content;
    },
  });
}

/** update_note: replaces the full body (not an append). */
export function createUpdateNoteTool(client: McpToolsClient) {
  return defineTool({
    name: "update_note",
    description:
      "修改已有笔记的标题或正文。content_md 是完整正文，会替换原内容（不是追加）；修改前先 get_note 读取原文，保留用户原有结构与措辞，只做必要的补全/修正。",
    inputSchema: z.object({
      note_uuid: z.string().min(1).describe("笔记 UUID"),
      content_md: z.string().min(1).max(50_000).describe("新的完整 Markdown 正文"),
      title: z.string().min(1).max(120).optional().describe("新标题（可选，不传则不改）"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) return "保存失败：当前会话没有用户身份。";
      const res = await client.callTool(
        "update_note",
        {
          note_uuid: args.note_uuid,
          content_md: args.content_md,
          ...(args.title ? { title: args.title } : {}),
        },
        { uid: ctx.uid },
      );
      if (!res.ok) return `保存失败：${res.error ?? "未知错误"}`;
      return res.content;
    },
  });
}
