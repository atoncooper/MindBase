import { z } from "zod";
import { defineTool } from "../base.js";
import type { MemoryRepository } from "../../repository/memory-store.js";

/**
 * save_memory: writes user long-term memory (uid from ToolRunContext; the LLM cannot specify identity).
 * Memory recall does not go through tools — the context layer injects it into the prompt each turn (see context/memory.ts).
 */
export function createSaveMemoryTool(store: MemoryRepository) {
  return defineTool({
    name: "save_memory",
    description: "保存一条用户长期记忆（偏好、背景、事实）。内容应独立自包含。",
    inputSchema: z.object({
      content: z.string().min(2).max(500).describe("记忆内容，一句话自包含"),
      tags: z.array(z.string()).optional().describe("标签，如 [\"偏好\",\"编程\"]"),
    }),
    async execute(args, ctx) {
      if (ctx.uid === undefined) {
        return "保存失败：当前会话没有用户身份。";
      }
      const entry = await store.add(ctx.uid, args.content, args.tags ?? []);
      return `已保存记忆 #${entry.id.slice(0, 8)}：${entry.content}`;
    },
  });
}
