import type { PlanGraph } from "./types.js";

/**
 * Built-in research-paper DAG. This is a template, not a separate agent: the
 * same PlanRunner/PlanRunEngine executes it; custom nodes are ephemeral ReAct
 * agents with the academic tools.
 */
export function buildResearchPaperGraph(input: {
  goal: string;
  projectId?: string;
  workspaceId?: string;
  deliverable?: string;
}): PlanGraph {
  const project = input.projectId ? "project_id=" + input.projectId : "（先创建 project_id）";
  const workspace = input.workspaceId ? "workspace_id=" + input.workspaceId : "（先 ensure_project）";
  const context = project + "；" + workspace + "；目标：" + input.goal;
  return {
    version: 1,
    goal: input.goal,
    agents: [
      {
        id: "topic",
        name: "选题",
        role: "研究问题与贡献点",
        system_prompt: "你是选题/研究设计节点。基于用户目标写出研究问题、贡献点、论文类型；不要编造文献。",
        tools: ["academic_project", "academic_literature"],
        max_steps: 6,
      },
      {
        id: "literature",
        name: "文献",
        role: "检索与核验文献",
        system_prompt: "你是文献节点。检索、核验并把文献写入项目 library；只使用真实检索结果。",
        tools: ["academic_literature", "vector_search"],
        max_steps: 8,
      },
      {
        id: "experiment",
        name: "实验",
        role: "代码/训练/数据分析",
        system_prompt: "你是实验节点。仅在 CS/SE/AI 的代码、训练、数据分析范围内执行；用 run_code 得到真实输出，并把数据/结果写入课题目录。禁止编造数字。",
        tools: ["run_code", "research_workspace", "academic_evidence"],
        max_steps: 10,
      },
      {
        id: "analysis",
        name: "分析",
        role: "结果表/图/统计",
        system_prompt: "你是分析节点。只根据实验真实输出生成表/图/统计摘要；每个结果必须带 [[run:<id>]] 证据引用。",
        tools: ["academic_evidence", "research_workspace", "run_code"],
        max_steps: 8,
      },
      {
        id: "writing",
        name: "写作",
        role: "论文写作",
        system_prompt: "你是写作节点。按论文结构写章节，引用项目文献；所有结果数字必须来自 evidence。",
        tools: ["academic_manuscript", "academic_literature", "academic_evidence"],
        max_steps: 10,
      },
      {
        id: "review",
        name: "审查",
        role: "引用/数字/可复现校验",
        system_prompt: "你是审查节点。调用 academic_validation，逐项修复缺失引用、未核验引用、缺少 run 证据、不可复现 run。",
        tools: ["academic_validation", "academic_manuscript"],
        max_steps: 8,
      },
    ],
    nodes: [
      { id: "topic", title: "明确研究问题", agent: "topic", deps: [], task: "为以下目标写研究问题、贡献点、论文类型：" + context, acceptance: "包含研究问题、贡献点、论文类型" },
      { id: "literature", title: "检索与核验文献", agent: "literature", deps: ["topic"], task: "检索并核验与课题相关文献，写入项目文献库：" + context, acceptance: "至少 5 条真实文献且 citeKey 可引用" },
      { id: "design", title: "研究设计与实验方案", agent: "topic", deps: ["topic", "literature"], task: "基于研究问题和文献写方法、变量、指标、实验方案：" + context, acceptance: "包含方法、指标、实验步骤" },
      { id: "experiment", title: "执行实验", agent: "experiment", deps: ["design"], task: "按方案执行代码/训练/数据分析，保存真实输出和 evidence：" + context, acceptance: "存在真实 run 输出与 evidence" },
      { id: "analysis", title: "结果分析", agent: "analysis", deps: ["experiment"], task: "基于 evidence 生成结果表/图/统计摘要：" + context, acceptance: "每项结果带 run 证据引用" },
      { id: "writing", title: "撰写论文", agent: "writing", deps: ["literature", "analysis"], task: "写论文各章节，引用文献和结果：" + context, acceptance: "章节完整，引用与数字可回链" },
      { id: "review", title: "论文校验", agent: "review", deps: ["writing"], task: "运行 academic_validation 并修复问题：" + context, acceptance: "校验通过" },
    ],
  };
}
