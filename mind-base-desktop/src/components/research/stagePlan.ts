/**
 * 科研工作台「研究计划」静态配置：每个阶段一份结构化计划。
 *
 * 这是控制台阶段化的数据源——六个阶段的计划各不相同（目标 / 关键任务 /
 * 交付物 / 验收标准 / 风险 / AI 快捷选择 / 相关资料入口），关键任务的勾选
 * 状态持久化在 research_stages.gate_json 的 {"checks": {...}} 里。
 *
 * 约定：任务 id 在阶段内唯一且稳定（改文案不要改 id，否则历史勾选会丢）。
 */

import type { ResearchStageId } from "../../lib/research";

/** 一条可勾选的关键任务。 */
export interface StagePlanTask {
  /** 阶段内稳定 id（持久化勾选用）。 */
  id: string;
  /** 中文任务描述。 */
  label: string;
}

/** 阶段相关资料入口：跳到对应 tab，并显示概览计数。 */
export interface StagePlanLink {
  tab: "literature" | "data" | "writing";
  label: string;
}

/** 一个阶段的完整研究计划。 */
export interface StagePlan {
  /** 阶段目标（一句话）。 */
  goal: string;
  /** 关键任务（可勾选，5 条）。 */
  tasks: StagePlanTask[];
  /** 交付物。 */
  deliverables: string[];
  /** 验收标准。 */
  acceptance: string[];
  /** 常见风险。 */
  risks: string[];
  /** AI 快捷选择（点击直接向研究助手提问）。 */
  prompts: string[];
  /** 相关资料入口。 */
  related: StagePlanLink[];
}

/** 六个阶段的计划。 */
export const STAGE_PLANS: Record<ResearchStageId, StagePlan> = {
  topic: {
    goal: "把研究兴趣收敛成一个可证伪、有文献缺口、能投目标期刊的研究问题。",
    tasks: [
      { id: "question", label: "用一句话写出研究问题（对象 + 变量/机制 + 边界）" },
      { id: "gap", label: "检索近三年 10 篇代表文献，标出仍未解决的缺口" },
      { id: "venue", label: "核对目标期刊近两年的选题偏好、篇幅与格式要求" },
      { id: "candidates", label: "列出 2-3 个候选选题，对比创新性与可行性" },
      { id: "contribution", label: "确定最终选题，写出一句话贡献声明" },
    ],
    deliverables: ["选题说明（研究问题 + 贡献）", "文献缺口清单（≥10 篇）", "候选选题对比表"],
    acceptance: [
      "研究问题能被实验或论证证伪",
      "缺口有文献支撑（可回指 cite key）",
      "贡献点一句话能说清，且不与已知工作重复",
    ],
    risks: ["选题过大，截止日期前做不完", "目标期刊近期已发表同题工作", "数据或实验条件不足以支撑"],
    prompts: [
      "给我 3 个可证伪的选题方向，并说明各自的文献缺口与风险",
      "帮我把当前选题收敛成一句话研究问题 + 贡献声明",
      "按目标期刊近两年的偏好，评估这个选题是否合适",
    ],
    related: [{ tab: "literature", label: "文献库" }],
  },
  design: {
    goal: "把选题落成可复现、可验收的研究设计（变量、对照、样本、分析方法）。",
    tasks: [
      { id: "variables", label: "明确自变量 / 因变量 / 对照与评价指标" },
      { id: "sample", label: "估算样本量与统计检验力，写清纳入排除标准" },
      { id: "flow", label: "画出实验 / 分析流程图，标注每步输入输出" },
      { id: "baselines", label: "确定基线方法与至少 2 个对照" },
      { id: "preregister", label: "预注册分析计划（含失败判据与备选方案）" },
    ],
    deliverables: ["研究设计说明（含变量与指标）", "实验 / 分析流程图", "分析计划与失败判据"],
    acceptance: [
      "他人能按设计复现实验",
      "每个指标都有明确计算口径",
      "有对照与消融，能区分贡献来源",
    ],
    risks: ["指标与结论不匹配（代理指标失效）", "样本量不足导致结论不稳", "数据获取或伦理审批延迟"],
    prompts: [
      "审阅我的研究设计，指出变量、对照与指标上的漏洞",
      "帮我估算样本量，并给出对应的统计检验方案",
      "为这个设计列出 2 个最强对照与 3 个消融实验",
    ],
    related: [{ tab: "data", label: "数据集" }],
  },
  advise: {
    goal: "把设计中的关键取舍与导师 / 合作者对齐，形成可追溯的决策记录。",
    tasks: [
      { id: "decisions", label: "列出 3-5 个待确认的关键决策（附选项与代价）" },
      { id: "review", label: "约一次导师 / 组会评审，逐条记录意见" },
      { id: "rationale", label: "对每条意见给出采纳 / 不采纳的理由" },
      { id: "record", label: "把结论写进决策记录，并回指证据" },
      { id: "replan", label: "更新研究设计与时间表" },
    ],
    deliverables: ["决策记录（选项 / 理由 / 结论）", "评审纪要", "更新后的研究计划"],
    acceptance: ["每条关键决策都有明确结论与理由", "分歧点有后续验证安排", "计划时间表已同步"],
    risks: ["意见分散导致方向反复", "决策没有留痕，后期无法解释", "过度依赖单一评审人"],
    prompts: [
      "把这 5 个设计决策整理成带选项与代价的评审清单",
      "根据我的决策记录，指出还没有闭环的分歧",
      "帮我把导师意见转成可执行的修改任务",
    ],
    related: [],
  },
  experiment: {
    goal: "用可复现的实验回答研究问题，并保留每一步的脚本、配置与结论。",
    tasks: [
      { id: "profile", label: "确认数据集画像（行数 / 列类型 / 缺失）并固定版本" },
      { id: "baseline", label: "跑通基线，记录配置与指标" },
      { id: "main", label: "运行主实验 + 对照 / 消融，固定随机种子" },
      { id: "stats", label: "做显著性检验与误差分析（失败案例分类）" },
      { id: "register", label: "把脚本、配置、结果表登记为产物" },
    ],
    deliverables: ["实验配置与脚本", "结果表（主实验 / 对照 / 消融）", "误差分析与结论"],
    acceptance: ["脚本可一键复跑并得到同量级结果", "结果表含均值±方差与显著性", "失败案例有归类与解释"],
    risks: ["数据泄漏或划分不一致", "调参过拟合验证集", "环境 / 版本漂移导致不可复现"],
    prompts: [
      "检查我的实验设计是否存在数据泄漏与划分问题",
      "帮我把结果表整理成论文可用的三线表",
      "针对当前误差分析，给出 3 个改进实验",
    ],
    related: [{ tab: "data", label: "数据与实验" }],
  },
  writing: {
    goal: "按目标期刊结构把证据写成可投稿的稿件，每个论断都能回指证据。",
    tasks: [
      { id: "outline", label: "定稿大纲与每节核心论点" },
      { id: "method", label: "写方法与实验（对齐设计文档与结果表）" },
      { id: "intro", label: "写引言与相关工作（引用已核验文献）" },
      { id: "discussion", label: "写讨论与局限，明确不适用范围" },
      { id: "polish", label: "统一图表、术语与参考文献格式" },
    ],
    deliverables: ["章节初稿（摘要 / 引言 / 方法 / 实验 / 讨论）", "图表与图注", "参考文献（BibTeX）"],
    acceptance: ["每个结论都能回指实验或文献", "方法与实验数字和结果表一致", "格式符合目标期刊模板"],
    risks: ["论证链断裂（结论超出证据）", "图表与正文数字不一致", "引用未核验文献"],
    prompts: [
      "按目标期刊结构给我的稿件列一份逐节写作清单",
      "审阅这一节，找出没有证据支撑的论断",
      "帮我把实验结果改写成方法 + 实验两节的初稿",
    ],
    related: [{ tab: "writing", label: "稿件章节" }],
  },
  submission: {
    goal: "完成投稿前的合规检查与材料准备，确保一次投出、全程可追溯。",
    tasks: [
      { id: "checklist", label: "核对期刊投稿清单（格式 / 字数 / 图注 / 伦理 / 数据可用性）" },
      { id: "cover", label: "准备 cover letter 与推荐审稿人" },
      { id: "authors", label: "检查作者贡献、利益冲突与基金标注" },
      { id: "archive", label: "归档投稿版本（PDF + 源文件 + 图表）" },
      { id: "track", label: "记录投稿编号与审稿意见的对应关系" },
    ],
    deliverables: ["投稿包（PDF / 源文件 / 图表）", "cover letter", "投稿检查清单"],
    acceptance: ["清单逐项打勾且无遗漏", "版本可追溯到具体日期 / commit", "审稿意见有对应回复模板"],
    risks: ["格式细节被退改", "作者信息 / 基金标注错误", "数据可用性声明缺失"],
    prompts: [
      "按目标期刊要求生成投稿前检查清单",
      "帮我写 cover letter 的贡献与创新点段落",
      "列出审稿人可能提出的 5 个尖锐问题及回应要点",
    ],
    related: [],
  },
};

/** 取某阶段的计划（未知阶段返回 null，界面退化不崩溃）。 */
export function stagePlan(stage: string): StagePlan | null {
  return (STAGE_PLANS as Record<string, StagePlan | undefined>)[stage] ?? null;
}

/** 解析 gate_json 里的勾选状态；兼容旧数据（[] / {} / 脏 JSON）→ 空对象。 */
export function parseStageChecks(gateJson: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(gateJson);
    if (typeof parsed !== "object" || parsed === null) return {};
    const checks = (parsed as { checks?: unknown }).checks;
    if (typeof checks !== "object" || checks === null) return {};
    const result: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(checks)) {
      if (value === true) result[id] = true;
    }
    return result;
  } catch {
    return {};
  }
}

/** 勾选状态 → 写回 gate_json 的字符串。 */
export function serializeStageChecks(checks: Record<string, boolean>): string {
  return JSON.stringify({ checks });
}

/** 计划完成进度：已完成任务数 / 总任务数。 */
export function stagePlanProgress(
  plan: StagePlan,
  checks: Record<string, boolean>,
): { done: number; total: number } {
  const done = plan.tasks.filter((task) => checks[task.id] === true).length;
  return { done, total: plan.tasks.length };
}

/** 生成可复制的 Markdown 计划（导出 / 粘贴给导师或 AI 用）。 */
export function stagePlanMarkdown(
  title: string,
  stageLabel: string,
  plan: StagePlan,
  checks: Record<string, boolean>,
): string {
  const progress = stagePlanProgress(plan, checks);
  const lines: string[] = [
    `# ${title} · ${stageLabel}阶段研究计划`,
    "",
    `目标：${plan.goal}`,
    `进度：${progress.done}/${progress.total}`,
    "",
    "## 关键任务",
  ];
  for (const task of plan.tasks) {
    lines.push(`- [${checks[task.id] === true ? "x" : " "}] ${task.label}`);
  }
  lines.push("", "## 交付物");
  for (const item of plan.deliverables) lines.push(`- ${item}`);
  lines.push("", "## 验收标准");
  for (const item of plan.acceptance) lines.push(`- ${item}`);
  lines.push("", "## 常见风险");
  for (const item of plan.risks) lines.push(`- ${item}`);
  return lines.join("\n");
}
