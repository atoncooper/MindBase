/**
 * 内置导图模板：新建导图时可挑选骨架，选完即得结构，只改内容即可。
 * 每个模板 = 名称 + 布局 + 一棵树（simple-mind-map 节点 data 结构，
 * uid 由引擎渲染时自动生成，无需手写）。
 */

import type { MindMapDoc, MindMapNodeData } from "../../lib/mindmap";

/** 快捷构造一棵子树。 */
function n(text: string, ...children: MindMapNodeData[]): MindMapNodeData {
  return { data: { text }, children };
}

export interface MindMapTemplateDef {
  name: string;
  /** 一句话说明（模板卡片副标题）。 */
  hint: string;
  doc: MindMapDoc;
}

export const BUILTIN_TEMPLATES: ReadonlyArray<MindMapTemplateDef> = [
  {
    name: "空白导图",
    hint: "从中心主题开始自由生长",
    doc: { root: n("中心主题"), layout: "logicalStructure" },
  },
  {
    name: "读书笔记",
    hint: "观点 / 摘录 / 行动启发",
    doc: {
      root: n(
        "书名",
        n("核心观点", n("观点一"), n("观点二"), n("观点三")),
        n("精彩摘录", n("页码 + 原文"), n("页码 + 原文")),
        n("行动启发", n("可以怎么做？"), n("可以用在哪？")),
        n("评价", n("推荐指数"), n("适合谁读")),
      ),
      layout: "logicalStructure",
    },
  },
  {
    name: "项目计划",
    hint: "目标 / 里程碑 / 任务 / 风险",
    doc: {
      root: n(
        "项目名称",
        n("目标", n("交付物"), n("验收标准")),
        n("里程碑", n("M1 启动"), n("M2 中期"), n("M3 交付")),
        n("任务分解", n("模块 A", n("A1"), n("A2")), n("模块 B", n("B1"), n("B2"))),
        n("风险", n("风险点", n("应对措施")), n("依赖")),
        n("复盘", n("做得好"), n("待改进")),
      ),
      layout: "logicalStructure",
    },
  },
  {
    name: "SWOT 分析",
    hint: "优势 / 劣势 / 机会 / 威胁",
    doc: {
      root: n(
        "分析对象",
        n("优势 S", n("内部"), n("可控")),
        n("劣势 W", n("内部"), n("待补")),
        n("机会 O", n("外部"), n("可借")),
        n("威胁 T", n("外部"), n("需防")),
      ),
      layout: "mindMap",
    },
  },
  {
    name: "周计划",
    hint: "周一到周五 + 周末复盘",
    doc: {
      root: n(
        "本周主题",
        n("周一", n("要事")),
        n("周二", n("要事")),
        n("周三", n("要事")),
        n("周四", n("要事")),
        n("周五", n("要事")),
        n("周末", n("复盘"), n("下周预告")),
      ),
      layout: "mindMap",
    },
  },
  {
    name: "鱼骨分析",
    hint: "归因：人机料法环",
    doc: {
      root: n(
        "要分析的问题",
        n("人", n("人员"), n("分工"), n("技能")),
        n("机", n("设备"), n("工具")),
        n("料", n("原料"), n("信息")),
        n("法", n("流程"), n("规范")),
        n("环", n("环境"), n("外部因素")),
      ),
      layout: "fishbone",
    },
  },
  {
    name: "头脑风暴",
    hint: "发散：六个方向各撑一枝",
    doc: {
      root: n(
        "头脑风暴主题",
        n("方向一"), n("方向二"), n("方向三"), n("方向四"), n("方向五"), n("方向六"),
      ),
      layout: "mindMap",
    },
  },
  {
    name: "年度总结",
    hint: "成果 / 不足 / 学习 / 展望",
    doc: {
      root: n(
        "这一年",
        n("成果", n("目标达成"), n("亮点事件")),
        n("不足", n("没做好的"), n("原因")),
        n("学习", n("读过的书"), n("新技能")),
        n("明年计划", n("目标"), n("第一步")),
      ),
      layout: "mindMap",
    },
  },
];
