// Declarative specs for interactive artifacts.
//
// The model never ships arbitrary HTML/JS for these kinds: it emits a small
// JSON spec that the client validates and renders with trusted components.
// This is the same "declarative spec" trade-off the MCP Apps / OpenUI ecosystem
// makes for widgets that do not need a full sandboxed app.

export interface PlotParamSpec {
  name: string;
  label?: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface PlotCurveSpec {
  expr: string;
  label?: string;
  color?: string;
}

export interface PlotSpec {
  kind: "plot";
  title: string;
  subtitle?: string;
  xMin: number;
  xMax: number;
  yMin?: number;
  yMax?: number;
  curves: PlotCurveSpec[];
  params?: PlotParamSpec[];
}

export type DiagramShape = "rect" | "round" | "diamond" | "ellipse";
export type DiagramTone = "default" | "accent" | "success" | "warning";

export interface DiagramNodeSpec {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  shape?: DiagramShape;
  tone?: DiagramTone;
}

export interface DiagramEdgeSpec {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface DiagramSpec {
  kind: "diagram";
  title: string;
  nodes: DiagramNodeSpec[];
  edges: DiagramEdgeSpec[];
}

export type InteractiveSpec = PlotSpec | DiagramSpec;

export function isPlotSpec(value: unknown): value is PlotSpec {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PlotSpec>;
  return (
    s.kind === "plot" &&
    typeof s.title === "string" &&
    typeof s.xMin === "number" &&
    typeof s.xMax === "number" &&
    Array.isArray(s.curves) &&
    s.curves.length > 0 &&
    s.curves.every((c) => !!c && typeof (c as PlotCurveSpec).expr === "string") &&
    (s.params === undefined || Array.isArray(s.params))
  );
}

export function isDiagramSpec(value: unknown): value is DiagramSpec {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<DiagramSpec>;
  return (
    s.kind === "diagram" &&
    typeof s.title === "string" &&
    Array.isArray(s.nodes) &&
    s.nodes.length > 0 &&
    s.nodes.every((n) => !!n && typeof n.id === "string" && typeof n.label === "string") &&
    Array.isArray(s.edges)
  );
}

// ---------------------------------------------------------------------------
// Demo payloads (what the model would emit as the artifact's `data`)
// ---------------------------------------------------------------------------

export const DEMO_PLOT: PlotSpec = {
  kind: "plot",
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
  kind: "diagram",
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
