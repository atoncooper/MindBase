/**
 * 考试蓝本注册表 —— 每种考试的标准题型分布（写死代码，AI 照蓝本逐步填充）。
 *
 * 设计约定：
 *  - type 必须映射到出题管线的四种题型：single_choice / multi_choice /
 *    short_answer / essay；真实考试的题型形态用 hint 描述（如"判断题形式：
 *    正确/错误二选一""案例分析题""读后续写"）。
 *  - count 为该题型的真实参考题量；总分 = 各题 score 之和（省略 score 时
 *    由管线按整卷 totalScore 均分）。
 *  - 结构为教学参考口径（随年份/公告微调），description 提示以官方为准。
 *  - AI 不得自行决定题量与题型分布；只能按本蓝本 + 用户覆盖题量缩放填充。
 */

export type QuizType = "single_choice" | "multi_choice" | "short_answer" | "essay";

export interface ExamBlueprintItem {
  type: QuizType;
  count: number;
  /** 每题分值；省略则均分 */
  score?: number;
  /** 该题型在本节的形态/考查要点提示（进入生成提示词） */
  hint?: string;
}

export interface ExamBlueprintSection {
  subject: string;
  difficulty?: "easy" | "medium" | "hard";
  items: ExamBlueprintItem[];
}

export interface ExamBlueprint {
  /** 风格 id（前端选择值 / QUIZ_STYLES 成员） */
  id: string;
  category: string;
  name: string;
  description: string;
  durationMinutes: number;
  /** 该考试的真实卷面总分；未标注 score 的题型项按它均分补齐（缺省回落 100） */
  totalScore?: number;
  sections: ExamBlueprintSection[];
}

export const EXAM_BLUEPRINTS: ExamBlueprint[] = [
  // ═══ 升学 · 高考 ═══
  { id: "gaokao-chinese", category: "升学 · 高考", name: "高考语文", description: "新课标高考语文卷面结构（现代文/古诗文/语用/写作）", durationMinutes: 150, totalScore: 150, sections: [
    { subject: "现代文阅读", items: [ { type: "single_choice", count: 5, hint: "信息类文本理解与推断" }, { type: "short_answer", count: 4, hint: "文学类文本赏析，须引文本依据" } ] },
    { subject: "古诗文阅读", items: [ { type: "single_choice", count: 3, hint: "文言文理解" }, { type: "short_answer", count: 2, hint: "古诗鉴赏 + 名篇默写" } ] },
    { subject: "语言文字运用", items: [ { type: "short_answer", count: 3, hint: "语用题：成语/病句/表达效果" } ] },
    { subject: "写作", items: [ { type: "essay", count: 1, score: 60, hint: "材料作文，不少于 800 字" } ] },
  ] },
  { id: "gaokao-math", category: "升学 · 高考", name: "高考数学", description: "新高考数学卷面结构（单选/多选/填空/解答，3:5:2 难度梯度）", durationMinutes: 120, totalScore: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 8, score: 5, hint: "1-6 基础，7-8 综合" } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 3, score: 6, hint: "部分选对得部分分" } ] },
    { subject: "填空题", items: [ { type: "short_answer", count: 3, score: 5 } ] },
    { subject: "解答题", items: [ { type: "essay", count: 5, hint: "分步设问、按步给分，含压轴" } ] },
  ] },
  { id: "gaokao-english", category: "升学 · 高考", name: "高考英语", description: "新高考英语笔试部分（阅读/七选五/完形/语法填空/写作；不含听力 30 分）", durationMinutes: 120, totalScore: 120, sections: [
    { subject: "阅读理解", items: [ { type: "single_choice", count: 20, score: 2.5, hint: "阅读 A 三篇 + 七选五一篇（2.5 分/题）" } ] },
    { subject: "完形与语法", items: [ { type: "single_choice", count: 15, score: 1, hint: "完形填空（1 分/题）" }, { type: "short_answer", count: 10, score: 1.5, hint: "语法填空（1.5 分/题）" } ] },
    { subject: "写作", items: [ { type: "essay", count: 1, score: 15, hint: "应用文写作" }, { type: "essay", count: 1, score: 25, hint: "读后续写" } ] },
  ] },
  { id: "gaokao-physics", category: "升学 · 高考", name: "高考物理", description: "物理选考卷面结构（选择/实验/计算）", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 7 }, { type: "multi_choice", count: 3 } ] },
    { subject: "非选择题", items: [ { type: "short_answer", count: 2, hint: "实验题：器材/步骤/误差" }, { type: "essay", count: 3, hint: "计算题：公式+代入+单位" } ] },
  ] },
  { id: "gaokao-chemistry", category: "升学 · 高考", name: "高考化学", description: "化学选考卷面结构", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 10 }, { type: "multi_choice", count: 4 } ] },
    { subject: "非选择题", items: [ { type: "essay", count: 4, hint: "方程式须配平并标注条件与状态符号" } ] },
  ] },
  { id: "gaokao-biology", category: "升学 · 高考", name: "高考生物", description: "生物选考卷面结构", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 12 }, { type: "multi_choice", count: 4 } ] },
    { subject: "非选择题", items: [ { type: "essay", count: 5, hint: "答案贴近教材原文术语；实验设计遵循对照与单一变量" } ] },
  ] },
  { id: "gaokao-history", category: "升学 · 高考", name: "高考历史", description: "历史选考卷面结构", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 15 }, { type: "multi_choice", count: 4 } ] },
    { subject: "非选择题", items: [ { type: "essay", count: 3, hint: "材料信息提取 + 史论结合" } ] },
  ] },
  { id: "gaokao-politics", category: "升学 · 高考", name: "高考政治", description: "政治选考卷面结构", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 15 }, { type: "multi_choice", count: 4 } ] },
    { subject: "非选择题", items: [ { type: "essay", count: 3, hint: "材料分析 + 时政口径 + 学科术语" } ] },
  ] },
  { id: "gaokao-geography", category: "升学 · 高考", name: "高考地理", description: "地理选考卷面结构", durationMinutes: 75, totalScore: 100, sections: [
    { subject: "选择题", items: [ { type: "single_choice", count: 15 }, { type: "multi_choice", count: 4 } ] },
    { subject: "非选择题", items: [ { type: "essay", count: 3, hint: "图表/区域分析 + 术语规范" } ] },
  ] },

  // ═══ 升学 · 考研 ═══
  { id: "kaoyan-politics", category: "升学 · 考研", name: "考研政治", description: "思想政治理论（单选 16×1 / 多选 17×2 / 分析题 5×10）", durationMinutes: 180, totalScore: 100, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 16, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 17, score: 2, hint: "多选少选错选均不得分" } ] },
    { subject: "分析题", items: [ { type: "essay", count: 5, score: 10, hint: "原理 + 材料结合 + 展开论述" } ] },
  ] },
  { id: "kaoyan-english1", category: "升学 · 考研", name: "考研英语一", description: "英语一（完形/阅读/新题型/翻译/写作）", durationMinutes: 180, totalScore: 100, sections: [
    { subject: "完形填空", items: [ { type: "single_choice", count: 20, score: 0.5 } ] },
    { subject: "阅读理解", items: [ { type: "single_choice", count: 25, score: 2, hint: "阅读 A 20 题 + 新题型 5 题" } ] },
    { subject: "翻译与写作", items: [ { type: "short_answer", count: 5, score: 2, hint: "长难句翻译，踩点给分" }, { type: "essay", count: 1, score: 10, hint: "小作文：书信/通知等应用文" }, { type: "essay", count: 1, score: 20, hint: "大作文：图画/图表议论文" } ] },
  ] },
  { id: "kaoyan-english2", category: "升学 · 考研", name: "考研英语二", description: "英语二（完形/阅读/新题型/翻译/写作）", durationMinutes: 180, totalScore: 100, sections: [
    { subject: "完形填空", items: [ { type: "single_choice", count: 20, score: 0.5 } ] },
    { subject: "阅读理解", items: [ { type: "single_choice", count: 25, score: 2, hint: "阅读 A 20 题 + 新题型 5 题" } ] },
    { subject: "翻译与写作", items: [ { type: "essay", count: 1, score: 15, hint: "段落翻译" }, { type: "essay", count: 1, score: 10, hint: "小作文：应用文" }, { type: "essay", count: 1, score: 15, hint: "大作文：图表分析" } ] },
  ] },
  { id: "kaoyan-math1", category: "升学 · 考研", name: "考研数学一", description: "数学一（高数 56% / 线代 22% / 概率 22%，含曲线曲面积分与傅里叶）", durationMinutes: 180, totalScore: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 10, score: 5, hint: "1-6 基础，7-10 综合" } ] },
    { subject: "填空题", items: [ { type: "short_answer", count: 6, score: 5 } ] },
    { subject: "解答题", items: [ { type: "essay", count: 6, hint: "跨章节综合，按步给分，含压轴证明" } ] },
  ] },
  { id: "kaoyan-math2", category: "升学 · 考研", name: "考研数学二", description: "数学二（高数 78% / 线代 22%，不考概率与级数）", durationMinutes: 180, totalScore: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 10, score: 5 } ] },
    { subject: "填空题", items: [ { type: "short_answer", count: 6, score: 5 } ] },
    { subject: "解答题", items: [ { type: "essay", count: 6, hint: "不出现无穷级数与曲线曲面积分" } ] },
  ] },
  { id: "kaoyan-math3", category: "升学 · 考研", name: "考研数学三", description: "数学三（经济类，含差分方程与边际弹性）", durationMinutes: 180, totalScore: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 10, score: 5 } ] },
    { subject: "填空题", items: [ { type: "short_answer", count: 6, score: 5 } ] },
    { subject: "解答题", items: [ { type: "essay", count: 6, hint: "经济应用素材（成本收益、边际弹性）" } ] },
  ] },
  { id: "kaoyan-408", category: "升学 · 考研", name: "408 计算机学科基础", description: "数据结构 45 / 组成原理 45 / 操作系统 35 / 网络 25", durationMinutes: 180, totalScore: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 40, score: 2, hint: "四门混排，结果唯一可判定" } ] },
    { subject: "综合应用题", items: [ { type: "essay", count: 7, score: 10, hint: "算法题含复杂度分析；PV 操作先声明信号量；计算题参数完备" } ] },
  ] },
  { id: "kaoyan-396", category: "升学 · 考研", name: "396 经济类联考", description: "数学基础 + 逻辑 + 写作（压缩练习卷：不含逻辑 20 题 40 分）", durationMinutes: 180, sections: [
    { subject: "数学基础与逻辑", items: [ { type: "single_choice", count: 35, score: 2, hint: "数学 35 分 + 逻辑 40 分混排" } ] },
    { subject: "写作", items: [ { type: "essay", count: 1, score: 20, hint: "论证有效性分析" }, { type: "essay", count: 1, score: 20, hint: "论说文" } ] },
  ] },
  { id: "kaoyan-law", category: "升学 · 考研", name: "法律硕士（法硕）", description: "法硕联考专业基础（刑法/民法/法理/宪法/法制史）", durationMinutes: 180, totalScore: 150, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 40, score: 1 }, { type: "multi_choice", count: 5, score: 2, hint: "多选少选均不得分" } ] },
    { subject: "主观题", items: [ { type: "short_answer", count: 4, score: 10, hint: "简答题" }, { type: "essay", count: 3, score: 20, hint: "法条分析 / 案例分析 / 论述" } ] },
  ] },
  { id: "kaoyan-education", category: "升学 · 考研", name: "教育学 311", description: "教育学专业基础（教原/中外教史/教心/教研）", durationMinutes: 180, totalScore: 300, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 45, score: 2 } ] },
    { subject: "主观题", items: [ { type: "short_answer", count: 4 }, { type: "essay", count: 3, hint: "分析论述，须结合教育学理论" } ] },
  ] },
  { id: "kaoyan-psychology", category: "升学 · 考研", name: "心理学 312", description: "心理学专业基础（普心/发展/教育/实验/统计/测量）", durationMinutes: 180, totalScore: 300, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 65, score: 2 }, { type: "multi_choice", count: 10, score: 3 } ] },
    { subject: "主观题", items: [ { type: "short_answer", count: 5, score: 10 }, { type: "essay", count: 3, score: 30, hint: "实验设计题须说明变量与控制" } ] },
  ] },
  { id: "kaoyan-history", category: "升学 · 考研", name: "历史学基础 313", description: "中国古代史/近现代史/世界史", durationMinutes: 180, totalScore: 300, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 20, score: 4 } ] },
    { subject: "主观题", items: [ { type: "short_answer", count: 4 }, { type: "essay", count: 4, hint: "史料分析 + 论述题" } ] },
  ] },
  { id: "kaoyan-westmed", category: "升学 · 考研", name: "西医综合 306", description: "生理/生化/病理/内科/外科（临床医学综合能力）", durationMinutes: 180, sections: [
    { subject: "A/B 型题", items: [ { type: "single_choice", count: 90, score: 1.5, hint: "A 型单选 + B 型共用备选答案" } ] },
    { subject: "X 型题与病例题", items: [ { type: "multi_choice", count: 30, score: 2 } ] },
  ] },

  // ═══ 语言考试 ═══
  { id: "lang-ielts", category: "语言考试", name: "雅思 IELTS（学术类）", description: "阅读 40 题 + 写作 Task1/Task2（听力口语需真人，不出题）", durationMinutes: 60, sections: [
    { subject: "阅读（学术类）", items: [ { type: "single_choice", count: 26, hint: "三篇长文，含判断题形式（True/False/Not Given 二选一）、匹配题" }, { type: "short_answer", count: 14, hint: "填空/简答/图表补全" } ] },
    { subject: "写作", items: [ { type: "essay", count: 2, hint: "Task1 图表描述 150 词 + Task2 议论文 250 词" } ] },
  ] },
  { id: "lang-toefl", category: "语言考试", name: "托福 TOEFL（阅读与写作）", description: "学术阅读 2 篇 + 学术讨论写作", durationMinutes: 60, sections: [
    { subject: "阅读", items: [ { type: "single_choice", count: 20, hint: "学术文章，含词汇题与推断题" } ] },
    { subject: "写作", items: [ { type: "essay", count: 1, hint: "学术讨论写作（表述观点并回应他人）" } ] },
  ] },
  { id: "lang-cet4", category: "语言考试", name: "大学英语四级 CET-4", description: "写作/阅读/翻译（笔试部分）", durationMinutes: 125, sections: [
    { subject: "写作与翻译", items: [ { type: "essay", count: 1, hint: "短文写作 120-180 词" }, { type: "short_answer", count: 1, hint: "段落汉译英 140-160 字" } ] },
    { subject: "阅读理解", items: [ { type: "single_choice", count: 20, hint: "选词填空 + 长篇匹配 + 仔细阅读" } ] },
  ] },
  { id: "lang-cet6", category: "语言考试", name: "大学英语六级 CET-6", description: "六级笔试部分（阅读难度与词汇要求更高）", durationMinutes: 130, sections: [
    { subject: "写作与翻译", items: [ { type: "essay", count: 1, hint: "短文写作 150-200 词" }, { type: "short_answer", count: 1, hint: "段落汉译英 180-200 字" } ] },
    { subject: "阅读理解", items: [ { type: "single_choice", count: 20, hint: "选词填空 + 长篇匹配 + 仔细阅读" } ] },
  ] },
  { id: "lang-n1", category: "语言考试", name: "日语能力考 N1", description: "语言知识 + 阅读（文字词汇/语法/读解）", durationMinutes: 110, sections: [
    { subject: "语言知识", items: [ { type: "single_choice", count: 35, hint: "汉字读音/用法/语法形式判断" } ] },
    { subject: "读解", items: [ { type: "single_choice", count: 18, hint: "短/中/长篇 + 情报检索" } ] },
  ] },
  { id: "lang-n2", category: "语言考试", name: "日语能力考 N2", description: "语言知识 + 阅读", durationMinutes: 105, sections: [
    { subject: "语言知识", items: [ { type: "single_choice", count: 33, hint: "汉字/词汇/语法" } ] },
    { subject: "读解", items: [ { type: "single_choice", count: 16, hint: "短/中/长篇读解" } ] },
  ] },
  { id: "lang-bec", category: "语言考试", name: "BEC 中级（阅读与写作）", description: "商务英语阅读 5 部分 + 写作", durationMinutes: 90, sections: [
    { subject: "阅读", items: [ { type: "single_choice", count: 30, hint: "匹配/填空/正误判断" } ] },
    { subject: "写作", items: [ { type: "essay", count: 2, hint: "商务便笺/备忘录 + 商务报告/书信" } ] },
  ] },

  // ═══ 公务员 · 事业编 ═══
  { id: "civil-guokao-xingce", category: "公务员 · 事业编", name: "国考行测", description: "行政职业能力测验（常识/言语/数量/判断/资料）", durationMinutes: 120, sections: [
    { subject: "常识判断", items: [ { type: "single_choice", count: 20, hint: "政治/法律/经济/历史/科技常识" } ] },
    { subject: "言语理解与表达", items: [ { type: "single_choice", count: 40, hint: "逻辑填空 + 片段阅读" } ] },
    { subject: "数量关系", items: [ { type: "single_choice", count: 15, hint: "数学运算，可用代入排除法" } ] },
    { subject: "判断推理", items: [ { type: "single_choice", count: 40, hint: "图形/定义/类比/逻辑判断" } ] },
    { subject: "资料分析", items: [ { type: "single_choice", count: 20, hint: "文字/表格/图形材料，增长率与比重计算" } ] },
  ] },
  { id: "civil-guokao-shenlun", category: "公务员 · 事业编", name: "国考申论", description: "阅读概括 / 对策 / 应用文 / 大作文", durationMinutes: 180, sections: [
    { subject: "归纳概括与对策", items: [ { type: "short_answer", count: 3, hint: "给定资料概括问题/原因/对策，字数严格" } ] },
    { subject: "应用文与大作文", items: [ { type: "essay", count: 2, hint: "公文应用文 + 议论文（1000-1200 字）" } ] },
  ] },
  { id: "civil-shengkao", category: "公务员 · 事业编", name: "省考行测", description: "省级公务员行测（题量与国考相近，侧重本地时政）", durationMinutes: 120, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 100, hint: "常识/言语/数量/判断/资料五大模块混排" } ] },
    { subject: "判断推理强化", items: [ { type: "multi_choice", count: 10, hint: "部分省份多选题型" } ] },
  ] },
  { id: "civil-shiye", category: "公务员 · 事业编", name: "事业单位 A 类", description: "职业能力倾向测验 + 综合应用能力", durationMinutes: 120, sections: [
    { subject: "职测", items: [ { type: "single_choice", count: 60, hint: "常识/言语/数量/判断/资料" } ] },
    { subject: "综合应用能力", items: [ { type: "essay", count: 3, hint: "归纳概括 + 观点归纳 + 应急处理" } ] },
  ] },
  { id: "civil-junwen", category: "公务员 · 事业编", name: "军队文职（公共科目）", description: "基本知识 + 岗位能力", durationMinutes: 120, sections: [
    { subject: "基本知识", items: [ { type: "single_choice", count: 50, hint: "政治/法律/人文/国防军队常识" } ] },
    { subject: "岗位能力", items: [ { type: "single_choice", count: 50, hint: "言语/数量/判断/资料" } ] },
  ] },

  // ═══ 职业资格 · 建工 ═══
  { id: "eng-architect1", category: "职业资格 · 建工", name: "一级注册建筑师（知识题）", description: "设计前期与场地/建筑设计/结构/物理设备/材料构造（知识题部分）", durationMinutes: 120, sections: [
    { subject: "设计前期与场地设计", items: [ { type: "single_choice", count: 20, hint: "场地分析/规范条文" } ] },
    { subject: "建筑设计", items: [ { type: "single_choice", count: 30, hint: "设计原理/建筑历史/规范" } ] },
    { subject: "结构与物理设备", items: [ { type: "single_choice", count: 30, hint: "结构力学概念 + 声光热 + 设备" } ] },
    { subject: "材料与构造", items: [ { type: "single_choice", count: 20, hint: "材料性能 + 构造做法" } ] },
  ] },
  { id: "eng-jianzao2", category: "职业资格 · 建工", name: "二级建造师（施工管理）", description: "建设工程施工管理（单选 + 多选）", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 60, score: 1, hint: "施工管理/成本/进度/质量/安全" } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 25, score: 2, hint: "错选不得分，少选按所选对的数量给分" } ] },
  ] },
  { id: "eng-jianzao1", category: "职业资格 · 建工", name: "一级建造师（工程经济）", description: "建设工程经济（工程财务/估价/经济计算）", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 60, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 20, score: 2 } ] },
  ] },
  { id: "eng-jiagou", category: "职业资格 · 建工", name: "注册结构工程师（基础）", description: "结构基础（数学/物理/化学/力学/结构设计原理）", durationMinutes: 240, sections: [
    { subject: "公共基础", items: [ { type: "single_choice", count: 60, hint: "数学/物理/化学/理论力学/材料力学" } ] },
    { subject: "专业基础", items: [ { type: "single_choice", count: 60, hint: "结构力学/土力学/结构设计" } ] },
  ] },
  { id: "eng-yantu", category: "职业资格 · 建工", name: "注册岩土工程师（基础）", description: "岩土基础（公共基础 + 专业基础）", durationMinutes: 240, sections: [
    { subject: "公共基础", items: [ { type: "single_choice", count: 60 } ] },
    { subject: "专业基础", items: [ { type: "single_choice", count: 60, hint: "岩体力学/土力学/基础工程" } ] },
  ] },
  { id: "eng-zaojia", category: "职业资格 · 建工", name: "一级造价工程师（基础科目）", description: "建设工程造价管理 + 计价", durationMinutes: 150, sections: [
    { subject: "造价管理", items: [ { type: "single_choice", count: 60 }, { type: "multi_choice", count: 20 } ] },
    { subject: "工程计价", items: [ { type: "single_choice", count: 40 }, { type: "multi_choice", count: 20 } ] },
  ] },
  { id: "eng-jianli", category: "职业资格 · 建工", name: "监理工程师（建设工程合同管理）", description: "合同管理（单选 + 多选）", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 50, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 30, score: 2 } ] },
  ] },
  { id: "eng-xiaofang", category: "职业资格 · 建工", name: "一级消防工程师（技术实务）", description: "消防安全技术实务（单选 + 多选）", durationMinutes: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 80, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 20, score: 2 } ] },
  ] },
  { id: "eng-anquan", category: "职业资格 · 建工", name: "中级注册安全工程师（安全生产管理）", description: "安全生产管理（单选 + 多选）", durationMinutes: 150, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 70, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 15, score: 2 } ] },
  ] },

  // ═══ 财会 · 金融 ═══
  { id: "fin-cpa", category: "财会 · 金融", name: "CPA 注册会计师（会计）", description: "会计科目（单选 + 多选 + 计算分析 + 综合）", durationMinutes: 180, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 13, score: 2 }, { type: "multi_choice", count: 12, score: 2 } ] },
    { subject: "主观题", items: [ { type: "essay", count: 4, hint: "计算分析题 + 综合题（会计分录与计算）" } ] },
  ] },
  { id: "fin-kuaiji-chuji", category: "财会 · 金融", name: "初级会计（初级会计实务）", description: "初级会计实务（单选 + 多选 + 判断 + 不定项）", durationMinutes: 105, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 40, hint: "单选 + 多选 + 判断题形式（正确/错误二选一）" }, { type: "multi_choice", count: 15 } ] },
    { subject: "不定项选择题", items: [ { type: "multi_choice", count: 15, hint: "案例不定项选择" } ] },
  ] },
  { id: "fin-kuaiji-zhongji", category: "财会 · 金融", name: "中级会计（中级会计实务）", description: "中级会计实务（单选 + 多选 + 判断 + 计算 + 综合）", durationMinutes: 165, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 30 }, { type: "multi_choice", count: 15 } ] },
    { subject: "主观题", items: [ { type: "essay", count: 3, hint: "计算分析题 + 综合题（会计分录）" } ] },
  ] },
  { id: "fin-shuiwu", category: "财会 · 金融", name: "税务师（税法一）", description: "税法一（单选 + 多选 + 计算 + 综合）", durationMinutes: 150, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 40 }, { type: "multi_choice", count: 20 } ] },
    { subject: "计算与综合", items: [ { type: "essay", count: 2, hint: "应纳税额计算题" } ] },
  ] },
  { id: "fin-jingjishi", category: "财会 · 金融", name: "经济师（经济基础知识）", description: "中级经济师 经济基础知识（单选 + 多选）", durationMinutes: 90, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 70, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 35, score: 2 } ] },
  ] },
  { id: "fin-yinhang", category: "财会 · 金融", name: "银行从业（法律法规）", description: "银行业法律法规与综合能力（单选 + 多选 + 判断）", durationMinutes: 120, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 80, hint: "单选 + 判断题形式（正确/错误二选一）" }, { type: "multi_choice", count: 40 } ] },
  ] },
  { id: "fin-zhengquan", category: "财会 · 金融", name: "证券从业（金融市场基础知识）", description: "证券市场基本法律法规 + 金融市场基础", durationMinutes: 120, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 100, hint: "单选 + 组合选择题形式" }, { type: "multi_choice", count: 50 } ] },
  ] },
  { id: "fin-jijin", category: "财会 · 金融", name: "基金从业（法律法规）", description: "基金法律法规、职业道德与业务规范", durationMinutes: 120, sections: [
    { subject: "客观题", items: [ { type: "single_choice", count: 100, hint: "单选 + 组合选择题形式" } ] },
  ] },

  // ═══ 法律 · 教资 · 医卫 ═══
  { id: "qual-fakao", category: "法律 · 教资 · 医卫", name: "法律职业资格（客观题卷一）", description: "刑法/刑诉/行政/理论法（客观题）", durationMinutes: 180, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 50, score: 1 } ] },
    { subject: "多项选择题", items: [ { type: "multi_choice", count: 50, score: 2, hint: "含多选与不定项选择" } ] },
  ] },
  { id: "qual-jiaoshi", category: "法律 · 教资 · 医卫", name: "教师资格证（综合素质）", description: "综合素质（职业理念/法规/职业道德/文化素养/基本能力）", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 29, score: 2 } ] },
    { subject: "材料分析与写作", items: [ { type: "short_answer", count: 3, hint: "材料分析题（职业理念/职业道德/阅读理解）" }, { type: "essay", count: 1, score: 50, hint: "写作题（不少于 1000 字）" } ] },
  ] },
  { id: "qual-hushi", category: "法律 · 教资 · 医卫", name: "护士执业资格考试", description: "专业实务 + 实践能力（A1/A2/A3/A4 型题）", durationMinutes: 100, sections: [
    { subject: "专业实务", items: [ { type: "single_choice", count: 100, hint: "A1 型（简明扼要）+ A2 型（病例摘要）" } ] },
    { subject: "实践能力", items: [ { type: "single_choice", count: 100, hint: "A3/A4 型（病例组题，共用题干）" } ] },
  ] },
  { id: "qual-yishi", category: "法律 · 教资 · 医卫", name: "执业医师（医学综合 笔试）", description: "医学综合（A1/A2/B1/A3A4 型题）", durationMinutes: 120, sections: [
    { subject: "基础与临床综合", items: [ { type: "single_choice", count: 120, hint: "A1 型单选 + A2 型病例摘要 + B1 型共用备选" } ] },
    { subject: "综合应用", items: [ { type: "multi_choice", count: 30, hint: "X 型题（多选）" } ] },
  ] },
  { id: "qual-yaoshi", category: "法律 · 教资 · 医卫", name: "执业药师（药学专业知识一）", description: "药学专业知识一（A/B/C/X 型题）", durationMinutes: 120, sections: [
    { subject: "A/B 型题", items: [ { type: "single_choice", count: 100, hint: "最佳选择题 + 配伍选择题" } ] },
    { subject: "综合分析题", items: [ { type: "single_choice", count: 20, hint: "C 型题（综合分析）+ X 型题（多选）" } ] },
  ] },

  // ═══ IT · 计算机 ═══
  { id: "it-ruankao-ruanjian", category: "IT · 计算机", name: "软考 · 软件设计师（中级）", description: "基础知识（75 单选）+ 应用技术（案例分析）", durationMinutes: 210, sections: [
    { subject: "基础知识（上午场）", items: [ { type: "single_choice", count: 75, hint: "数据结构/OS/网络/软件工程/知识产权" } ] },
    { subject: "应用技术（下午场）", items: [ { type: "essay", count: 4, hint: "数据流图/数据库设计/UML/算法填空" } ] },
  ] },
  { id: "it-ruankao-wangluo", category: "IT · 计算机", name: "软考 · 网络工程师（中级）", description: "网络基础知识 + 应用技术", durationMinutes: 210, sections: [
    { subject: "基础知识（上午场）", items: [ { type: "single_choice", count: 75, hint: "网络体系结构/路由交换/无线/安全" } ] },
    { subject: "应用技术（下午场）", items: [ { type: "essay", count: 4, hint: "网络规划/交换路由配置/故障排查" } ] },
  ] },
  { id: "it-ruankao-jiagou", category: "IT · 计算机", name: "软考 · 系统架构设计师（高级）", description: "综合知识 + 案例分析 + 论文", durationMinutes: 240, sections: [
    { subject: "综合知识", items: [ { type: "single_choice", count: 75 } ] },
    { subject: "案例分析", items: [ { type: "essay", count: 3, hint: "质量属性/架构评估/数据库/Web 架构" } ] },
    { subject: "论文", items: [ { type: "essay", count: 1, hint: "四选一论述（2500 字左右）" } ] },
  ] },
  { id: "it-ruankao-xiangmu", category: "IT · 计算机", name: "软考 · 信息系统项目管理师（高级）", description: "综合知识 + 案例分析 + 论文", durationMinutes: 240, sections: [
    { subject: "综合知识", items: [ { type: "single_choice", count: 75, hint: "十大知识领域/敏捷/运筹" } ] },
    { subject: "案例分析", items: [ { type: "essay", count: 3, hint: "进度/成本/质量/变更管理计算与纠偏" } ] },
    { subject: "论文", items: [ { type: "essay", count: 1, hint: "双论题选一（2500 字左右）" } ] },
  ] },
  { id: "it-dengji-python", category: "IT · 计算机", name: "计算机二级 Python", description: "单选 + 程序填空/改错/编写", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 40, hint: "语法/数据类型/控制结构/函数/库" } ] },
    { subject: "程序题", items: [ { type: "short_answer", count: 2, hint: "程序填空与改错" }, { type: "essay", count: 2, hint: "编程题（读入-处理-输出）" } ] },
  ] },
  { id: "it-dengji-office", category: "IT · 计算机", name: "计算机二级 MS Office", description: "单选 + Word/Excel/PPT 操作要点", durationMinutes: 120, sections: [
    { subject: "单项选择题", items: [ { type: "single_choice", count: 20, hint: "计算机基础 + Office 概念" } ] },
    { subject: "操作要点题", items: [ { type: "short_answer", count: 10, hint: "以步骤描述形式考查 Word/Excel/PPT 操作要点" } ] },
  ] },
  { id: "it-hcia", category: "IT · 计算机", name: "华为 HCIA-Datacom", description: "数通基础（单选/多选/判断）", durationMinutes: 90, sections: [
    { subject: "单选与判断", items: [ { type: "single_choice", count: 50, hint: "TCP-IP/路由交换/VLAN/ACL/组网" }, { type: "multi_choice", count: 15 } ] },
  ] },
  { id: "it-pmp", category: "IT · 计算机", name: "PMP 项目管理认证", description: "人员/过程/业务环境三大领域情景题", durationMinutes: 230, sections: [
    { subject: "情景题", items: [ { type: "single_choice", count: 180, hint: "情境判断：相关方/范围/进度/风险/敏捷混合" } ] },
  ] },
  { id: "gaokao-generic", category: "升学 · 高考", name: "高考综合练习（跨科）", description: "跨科目综合练习卷（各科混排，适合作业与每日一练）", durationMinutes: 120, sections: [
    { subject: "理科向", items: [ { type: "single_choice", count: 10, hint: "数理化生混排" } ] },
    { subject: "文科向", items: [ { type: "single_choice", count: 10, hint: "史地政混排" } ] },
    { subject: "语言", items: [ { type: "short_answer", count: 5, hint: "语文/英语混排" } ] },
  ] },
  { id: "kaoyan-generic", category: "升学 · 考研", name: "考研综合练习（跨科）", description: "公共课混排练习卷（政治/英语/数学每日一练）", durationMinutes: 120, sections: [
    { subject: "政治与英语", items: [ { type: "single_choice", count: 12, hint: "政治单选 + 英语阅读混排" } ] },
    { subject: "数学", items: [ { type: "short_answer", count: 5, hint: "填空 + 计算" } ] },
  ] },
];

/** 蓝本总题数（各节 items count 之和）。 */
export function blueprintTotal(bp: ExamBlueprint): number {
  return bp.sections.reduce((a, s) => a + s.items.reduce((b, i) => b + i.count, 0), 0);
}

/** 已标注分值项的分值合计（count × score）。 */
export function blueprintScoredTotal(bp: ExamBlueprint): number {
  return bp.sections.reduce(
    (a, s) => a + s.items.reduce((b, i) => b + (typeof i.score === "number" ? i.count * i.score : 0), 0),
    0,
  );
}

/**
 * 卷面总分：优先 totalScore（真实考试总分）；否则 = 已标注分值合计（全部
 * 标注时即精确总分）；再否则 100（通用练习口径）。
 */
export function blueprintExamTotal(bp: ExamBlueprint): number {
  if (typeof bp.totalScore === "number" && bp.totalScore > 0) return bp.totalScore;
  const scored = blueprintScoredTotal(bp);
  return scored > 0 ? scored : 100;
}

export function getBlueprint(styleId: string): ExamBlueprint | undefined {
  return EXAM_BLUEPRINTS.find((b) => b.id === styleId);
}

export const QUIZ_STYLE_IDS = EXAM_BLUEPRINTS.map((b) => b.id);
