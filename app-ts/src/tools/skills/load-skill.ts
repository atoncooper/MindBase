import { z } from "zod";
import { config } from "../../config/index.js";
import type { ToolDefinition, ToolOutput } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import type { SkillManager } from "../../skills/manager.js";

/**
 * load_skill: pulls the full SKILL.md body of an installed skill into the
 * conversation. uid comes from ToolRunContext (never an LLM parameter).
 */
export function createLoadSkillTool(manager: SkillManager): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "加载已安装技能的详细指令。当用户任务匹配系统提示中列出的技能时调用；" +
      "返回技能全文，请严格按其指引执行。",
    inputSchema: z.object({
      name: z.string().min(1).describe("技能 ID（见系统提示的可用技能列表）"),
      path: z.string().min(1).optional().describe(
        "技能内附加文件路径（可选）。load_skill 只返回指令正文；技能列出的附加文件（references 等）用该参数按需读取",
      ),
    }),
    async execute(args: { name: string; path?: string }, ctx: ToolRunContext): Promise<ToolOutput> {
      if (!config.skills.enabled) {
        return { content: "技能功能未启用。" };
      }
      if (ctx.uid === undefined) {
        return { content: "缺少用户身份，无法加载技能。" };
      }
      const body = await manager.loadBody(ctx.uid, args.name, args.path);
      return { content: body };
    },
  };
}
