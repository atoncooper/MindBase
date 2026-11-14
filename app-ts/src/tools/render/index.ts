import { z } from "zod";
import { defineTool } from "../base.js";
import {
  buildChartArtifact,
  buildComparisonArtifact,
  buildDiagramArtifact,
  buildPlotArtifact,
  chartArgsSchema,
  comparisonArgsSchema,
  diagramArgsSchema,
  plotArgsSchema,
} from "../../artifacts/interactive.js";

/**
 * Interactive artifacts: the model emits a declarative spec (plot / diagram /
 * chart / comparison) instead of asking a sub-agent to write HTML. The web
 * client renders the spec with trusted components, so nothing executable ever
 * reaches the chat page.
 *
 * Cross-field validation (expression identifiers, edge endpoints, payload size)
 * happens here; invalid input returns a readable error so the ReAct loop can
 * correct itself and retry.
 */

export function createRenderPlotTool() {
  return defineTool({
    name: "render_plot",
    description:
      "生成一个可交互的函数图像产物：曲线用表达式描述，参数（振幅/频率等）自动变成滑块，用户可拖动实时看变化，并支持滚轮缩放、拖拽平移。当用户想「看图/看函数图像/参数怎么影响图形/拖着看变化」时调用。只用于数学函数，不用于统计图表。",
    inputSchema: plotArgsSchema,
    async execute(args) {
      const result = buildPlotArtifact(args);
      if (!result.ok) return `无法渲染：${result.error}。请修正参数后重试。`;
      const paramCount = args.params?.length ?? 0;
      const curveCount = args.curves.length;
      return {
        content: `已生成可交互函数图像《${args.title}》：${curveCount} 条曲线${paramCount > 0 ? `、${paramCount} 个参数滑块` : ""}。请先用一两句话说明每条曲线代表什么、拖动参数会怎样变化，不要重复贴公式代码。`,
        artifacts: [result.artifact],
      };
    },
  });
}

const CHART_TYPE_LABELS = { bar: "柱状图", line: "折线图", pie: "饼图" } as const;

export function createRenderChartTool() {
  return defineTool({
    name: "render_chart",
    description:
      "生成一个可交互的数据图表产物（柱状图 / 折线图 / 饼图），用于统计数据对比、时间趋势、占比。当用户想「画个图看数据/对比这几个数/趋势怎么样/各占多少」时调用：类别对比用 bar，随时间变化用 line，占比用 pie（只能 1 组 series）。数据必须来自对话上下文或工具结果，不要编造数值；数学函数图像请用 render_plot，不要把函数曲线塞进来。categories 与每组 series.values 必须一一对应且等长；类目最多 24 个、系列最多 6 组。",
    inputSchema: chartArgsSchema,
    async execute(args) {
      const result = buildChartArtifact(args);
      if (!result.ok) return `无法渲染：${result.error}。请修正类别 / 数据后重试。`;
      return {
        content: `已生成${CHART_TYPE_LABELS[args.chartType]}《${args.title}》：${args.categories.length} 个类别、${args.series.length} 组数据。请先用一两句话说明这张图说明了什么结论，不要逐条复述数值。`,
        artifacts: [result.artifact],
      };
    },
  });
}

export function createRenderComparisonTool() {
  return defineTool({
    name: "render_comparison",
    description:
      "生成一个方案 / 产品 / 路线对比产物（2-4 项并排，含 summary、pros/cons 与可选属性表），用于 A vs B 的选型对比（技术方案、产品、实现路线）。当用户问「选哪个/对比一下/各自优劣」且候选明确（2-4 个）时调用。pros/cons 与属性值必须来自对话上下文或工具结果，不得编造；超过 4 项或只是纯参数罗列时用表格 / 文字更清楚；流程与结构关系用 mermaid 或 render_diagram。",
    inputSchema: comparisonArgsSchema,
    async execute(args) {
      const result = buildComparisonArtifact(args);
      if (!result.ok) return `无法渲染：${result.error}。请修正对比项后重试。`;
      return {
        content: `已生成对比产物《${args.title}》：${args.items.length} 个对比项${args.recommendation ? "、含推荐结论" : ""}。请用一两句话给出取舍建议，不要逐条复述卡片内容。`,
        artifacts: [result.artifact],
      };
    },
  });
}

export function createRenderDiagramTool() {
  return defineTool({
    name: "render_diagram",
    description:
      "生成一个可缩放/可拖拽的流程图或架构图产物（节点 + 连线）。当用户想「画个流程/画架构图/把步骤画出来/要能拖着看细节」时调用。标准结构图（时序图/状态机/类图/ER 图）请直接用 ```mermaid 代码块回答，不要调用本工具；本工具用于需要自由布局、强调分组、可缩放拖拽查看的架构图/链路图。节点坐标需要自己排版（从左到右或从上到下），不要与 render_plot 混用。",
    inputSchema: diagramArgsSchema,
    async execute(args) {
      const result = buildDiagramArtifact(args);
      if (!result.ok) return `无法渲染：${result.error}。请修正节点 id / 连线后重试。`;
      return {
        content: `已生成流程图《${args.title}》：${args.nodes.length} 个节点、${args.edges.length} 条连线，用户可以缩放/拖拽查看。请用一两句话概括这张图的阅读顺序，不要复述每个节点。`,
        artifacts: [result.artifact],
      };
    },
  });
}
