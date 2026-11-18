import { config } from "../../config/index.js";

/** 科研 DAG 可用的工具；不含 run_code/sandbox_*，实验执行必须走审批。 */
export const ACADEMIC_PLAN_TOOLS = [
  "academic_project",
  "academic_literature",
  "academic_manuscript",
  "academic_evidence",
  "academic_experiment",
  "academic_validation",
  "academic_analysis",
  "research_approval",
  "research_workspace",
  "docx_inspect",
  "vector_search",
] as const;

/** 合并配置与科研工具，并与实际注册的工具取交集；供 tool 校验与 runner 复用。 */
export function resolvePlanAllowedTools(registeredToolNames: Iterable<string>): string[] {
  const registered = new Set<string>();
  for (const name of registeredToolNames) if (typeof name === "string") registered.add(name);
  const requested = new Set<string>(config.agent.plan.allowedTools);
  if (config.academic.enabled) for (const tool of ACADEMIC_PLAN_TOOLS) requested.add(tool);
  return [...requested].filter((name) => registered.has(name));
}
