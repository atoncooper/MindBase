import type { ToolRunContext } from "../../context/types.js";

/** 科研项目内执行代码前的审批守卫；返回文本即拦截。 */
export type ResearchExecutionGuard = (ctx: ToolRunContext) => Promise<string | undefined>;
