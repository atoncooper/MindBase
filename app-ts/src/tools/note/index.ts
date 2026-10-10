import { z } from "zod";
import { defineTool } from "../base.js";
import type { McpToolsClient } from "../../mcp/index.js";

/**
 * save_note: saves a markdown note (uid from ToolRunContext). 红线（§2.15）：
 * 笔记落库一律经 app-note-mcp（save_note），本层绝不直连 note 表或任何仓储。
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
