// Demo payloads for the lab page — what the model would emit as artifact.data.
import type { DiagramSpec, PlotSpec } from "@/lib/artifacts/interactive-spec";

export const DEMO_PLOT: PlotSpec = {
  title: "y = a·sin(b·x + c) + d",
  subtitle: "拖动滑块改变参数，滚轮缩放、拖拽平移",
  xMin: -6.5,
  xMax: 6.5,
  curves: [
    { expr: "a*sin(b*x + c) + d", label: "f(x)", color: "#0071e3" },
    { expr: "a*b*cos(b*x + c)", label: "f′(x)", color: "#ff9f0a" },
  ],
  params: [
    { name: "a", label: "振幅 a", min: -3, max: 3, step: 0.05, value: 1.4 },
    { name: "b", label: "频率 b", min: 0.2, max: 4, step: 0.02, value: 1 },
    { name: "c", label: "相位 c", min: -Math.PI, max: Math.PI, step: 0.01, value: 0 },
    { name: "d", label: "偏移 d", min: -2, max: 2, step: 0.05, value: 0 },
  ],
};

export const DEMO_DIAGRAM: DiagramSpec = {
  title: "MindBase 对话检索链路",
  nodes: [
    { id: "user", label: "用户提问", x: 0, y: 96, w: 118, h: 52, shape: "round" },
    { id: "router", label: "AgentHarness\n路由 + ReAct", x: 150, y: 90, w: 152, h: 64, shape: "round", tone: "accent" },
    { id: "plan", label: "plan 工具\n步骤规划", x: 150, y: 0, w: 140, h: 48 },
    { id: "search", label: "vector_search\nMilvus 召回", x: 336, y: 10, w: 140, h: 52, tone: "success" },
    { id: "rerank", label: "Rerank 精排", x: 336, y: 92, w: 128, h: 48, tone: "success" },
    { id: "tool", label: "工具层\n笔记 / 白板 / 代码", x: 336, y: 176, w: 140, h: 52 },
    { id: "llm", label: "LLM 生成\n流式输出", x: 496, y: 90, w: 132, h: 56, shape: "round", tone: "accent" },
    { id: "ui", label: "交互式产物\n图表 · 流程图", x: 652, y: 88, w: 148, h: 60, shape: "round", tone: "warning" },
  ],
  edges: [
    { from: "user", to: "router" },
    { from: "router", to: "plan", dashed: true },
    { from: "router", to: "search" },
    { from: "search", to: "rerank" },
    { from: "rerank", to: "llm" },
    { from: "router", to: "tool" },
    { from: "tool", to: "llm" },
    { from: "llm", to: "ui" },
  ],
};
