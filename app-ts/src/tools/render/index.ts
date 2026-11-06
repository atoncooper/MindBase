import { z } from "zod";
import { defineTool } from "../base.js";
import {
  buildDiagramArtifact,
  buildPlotArtifact,
  diagramArgsSchema,
  plotArgsSchema,
} from "../../artifacts/interactive.js";

/**
 * Interactive artifacts: the model emits a declarative spec (plot / diagram)
 * instead of asking a sub-agent to write HTML. The web client renders the spec
 * with trusted components, so nothing executable ever reaches the chat page.
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

export function createRenderDiagramTool() {
  return defineTool({
    name: "render_diagram",
    description:
      "生成一个可缩放/可拖拽的流程图或架构图产物（节点 + 连线）。当用户想「画个流程/画架构图/把步骤画出来/要能拖着看细节」时调用。节点坐标需要自己排版（从左到右或从上到下），不要与 render_plot 混用。",
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
