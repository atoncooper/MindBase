import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Artifact } from "../context/types.js";

/**
 * Interactive artifact specs (plot / diagram / chart / comparison).
 *
 * The model emits a small, fully declarative JSON spec — never HTML or JS —
 * and the web client renders it with trusted components (canvas / SVG / DOM).
 * This module is the server-side contract: zod schemas shown to the model,
 * plus cross-field checks that zod alone cannot express (unique node ids,
 * edge endpoints, expression identifiers, chart category/series alignment,
 * comparison item uniqueness, payload size).
 *
 * Keep the limits in sync with frontendv2/lib/artifacts/interactive-spec.ts.
 */

export const SPEC_VERSION = 1;
export const MAX_SPEC_BYTES = 32 * 1024;
export const MAX_CURVES = 4;
export const MAX_PARAMS = 8;
export const MAX_EXPR_CHARS = 300;
export const MAX_NODES = 60;
export const MAX_EDGES = 120;
export const MAX_CHART_CATEGORIES = 24;
export const MAX_CHART_SERIES = 6;
export const MAX_COMPARISON_ITEMS = 4;
export const MAX_COMPARISON_LISTS = 6;
export const MAX_COMPARISON_ATTRS = 8;
export const MAX_ARTIFACTS_PER_TURN = 4;
export const MAX_ARTIFACT_BYTES_PER_TURN = 64 * 1024;

const FUNCS = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
  "sqrt", "abs", "exp", "ln", "log", "floor", "ceil", "round", "sign",
  "min", "max", "pow",
]);
const CONSTS = new Set(["pi", "e"]);

export const paramSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/).describe("参数名（单个字母或短标识符，如 a / b / k）"),
    label: z.string().min(1).max(40).optional().describe("滑块显示名，如「振幅」"),
    min: z.number().finite().describe("最小值"),
    max: z.number().finite().describe("最大值"),
    step: z.number().positive().describe("步长"),
    value: z.number().finite().describe("初始值，必须在 [min, max] 内"),
  })
  .refine((p) => p.max > p.min, { message: "max 必须大于 min" })
  .refine((p) => p.value >= p.min && p.value <= p.max, { message: "value 必须在 [min, max] 内" });

export const curveSchema = z.object({
  expr: z.string().min(1).max(MAX_EXPR_CHARS).describe("以 x 为自变量的表达式，可含参数名，如 a*sin(b*x + c) + d"),
  label: z.string().max(60).optional().describe("图例名，如 f(x)"),
});

export const plotArgsSchema = z.object({
  title: z.string().min(1).max(120).describe("图标题，如 y = a·sin(bx+c) + d"),
  subtitle: z.string().max(160).optional().describe("一句话说明怎么交互"),
  xMin: z.number().finite().describe("x 轴下界"),
  xMax: z.number().finite().describe("x 轴上界"),
  curves: z.array(curveSchema).min(1).max(MAX_CURVES).describe("曲线列表；主曲线放第一条"),
  params: z.array(paramSchema).max(MAX_PARAMS).optional().describe("可拖动参数（没有参数就省略）"),
});

const shapeSchema = z.enum(["rect", "round", "diamond", "ellipse"]);
const toneSchema = z.enum(["default", "accent", "success", "warning"]);

export const nodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).describe("唯一 id（英文/数字/-_），供连线引用"),
  label: z.string().min(1).max(80).describe("节点文字；换行用 \\n"),
  x: z.number().finite().min(-5000).max(5000).describe("左上角 x（画布坐标）"),
  y: z.number().finite().min(-5000).max(5000).describe("左上角 y（画布坐标）"),
  w: z.number().min(40).max(400).optional().describe("宽度，默认 156"),
  h: z.number().min(24).max(200).optional().describe("高度，默认 56"),
  shape: shapeSchema.optional().describe("形状：rect / round / diamond / ellipse"),
  tone: toneSchema.optional().describe("配色：default / accent（强调）/ success / warning"),
});

export const edgeSchema = z.object({
  from: z.string().min(1).max(32).describe("起点节点 id"),
  to: z.string().min(1).max(32).describe("终点节点 id"),
  label: z.string().max(40).optional().describe("连线上的文字"),
  dashed: z.boolean().optional().describe("虚线（异步/可选路径）"),
});

export const diagramArgsSchema = z.object({
  title: z.string().min(1).max(120).describe("图标题，如「检索链路」"),
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES).describe("节点列表，坐标自己排版：左→右或上→下，间距 ≥ 120"),
  edges: z.array(edgeSchema).max(MAX_EDGES).describe("连线列表，务必引用已存在的节点 id"),
});

const chartTypeSchema = z.enum(["bar", "line", "pie"]);

export const chartSeriesSchema = z.object({
  name: z.string().min(1).max(40).describe("系列名（图例），如「2024 年」「本周」"),
  values: z
    .array(z.number().finite().min(-1e12).max(1e12))
    .min(1)
    .max(MAX_CHART_CATEGORIES)
    .describe("与 categories 一一对应的数值，必须等长；只能是有限数"),
});

export const chartArgsSchema = z.object({
  title: z.string().min(1).max(120).describe("图标题，如「各月检索次数」"),
  subtitle: z.string().max(160).optional().describe("一句话说明数据口径或结论"),
  chartType: chartTypeSchema.describe("图表类型：bar（柱状，类别对比）/ line（折线，时间趋势）/ pie（饼图，占比；只能 1 组 series）"),
  categories: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(MAX_CHART_CATEGORIES)
    .describe("类别轴 / 扇区标签（1..24 个，每个 1..40 字）"),
  series: z
    .array(chartSeriesSchema)
    .min(1)
    .max(MAX_CHART_SERIES)
    .describe("数据系列（1..6 组）；每组 values 必须与 categories 等长；pie 只能 1 组"),
  unit: z.string().max(20).optional().describe("数值单位，如「次」「%」「元」"),
  xLabel: z.string().max(40).optional().describe("x 轴名称"),
  yLabel: z.string().max(40).optional().describe("y 轴名称（饼图可省略）"),
});

export const comparisonAttrSchema = z.object({
  label: z.string().max(40).describe("属性名，如「学习成本」"),
  value: z.string().max(80).describe("属性值，如「低」"),
});

export const comparisonItemSchema = z.object({
  name: z.string().min(1).max(60).describe("对比项名称（必须唯一），如「方案 A」"),
  summary: z.string().max(160).optional().describe("一句话定位/摘要"),
  pros: z.array(z.string().max(120)).max(MAX_COMPARISON_LISTS).optional().describe("优点（≤6 条，每条 ≤120 字）"),
  cons: z.array(z.string().max(120)).max(MAX_COMPARISON_LISTS).optional().describe("缺点（≤6 条，每条 ≤120 字）"),
  attrs: z.array(comparisonAttrSchema).max(MAX_COMPARISON_ATTRS).optional().describe("补充属性（≤8 组 label/value）"),
});

export const comparisonArgsSchema = z.object({
  title: z.string().min(1).max(120).describe("对比标题，如「PostgreSQL vs MySQL」"),
  subtitle: z.string().max(160).optional().describe("一句话说明对比口径 / 使用场景"),
  items: z.array(comparisonItemSchema).min(2).max(MAX_COMPARISON_ITEMS).describe("对比项（2..4 项），name 必须唯一"),
  recommendation: z.string().max(200).optional().describe("结论 / 推荐（≤200 字；没有把握就省略，不要编造）"),
});

export type PlotArgs = z.infer<typeof plotArgsSchema>;
export type DiagramArgs = z.infer<typeof diagramArgsSchema>;
export type ChartArgs = z.infer<typeof chartArgsSchema>;
export type ComparisonArgs = z.infer<typeof comparisonArgsSchema>;

export type PlotArtifactData = PlotArgs & { version: number; id: string };
export type DiagramArtifactData = DiagramArgs & { version: number; id: string };
export type ChartArtifactData = ChartArgs & { version: number; id: string };
export type ComparisonArtifactData = ComparisonArgs & { version: number; id: string };

/** Reject identifiers that are neither x, a declared param, a whitelisted function nor a constant. */
export function validateExpression(expr: string, params: readonly string[]): string | null {
  if (!/^[0-9A-Za-z_+\-*/^().,\s]+$/.test(expr)) {
    return "表达式只能包含数字、变量、括号和 + - * / ^ 与函数调用";
  }
  const allowed = new Set<string>(["x", ...params.map((p) => p.toLowerCase()), ...FUNCS, ...CONSTS]);
  const identifiers = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const raw of identifiers) {
    if (!allowed.has(raw.toLowerCase())) {
      return `表达式里有未知变量/函数 "${raw}"（可用：x、${params.join(", ") || "无参数"}、sin/cos/tan/sqrt/abs/log/ln/exp 等）`;
    }
  }
  return null;
}

function oversized(data: unknown): string | null {
  const size = Buffer.byteLength(JSON.stringify(data), "utf8");
  return size > MAX_SPEC_BYTES ? `spec 体积 ${size}B 超过上限 ${MAX_SPEC_BYTES}B，请精简节点/标签` : null;
}

export function buildPlotArtifact(args: PlotArgs): { ok: true; artifact: Artifact } | { ok: false; error: string } {
  if (args.xMax <= args.xMin) return { ok: false, error: "xMax 必须大于 xMin" };
  const paramNames = (args.params ?? []).map((p) => p.name);
  if (new Set(paramNames).size !== paramNames.length) return { ok: false, error: "参数名不能重复" };
  for (const curve of args.curves) {
    const error = validateExpression(curve.expr, paramNames);
    if (error) return { ok: false, error };
  }
  const data: PlotArtifactData = { ...args, version: SPEC_VERSION, id: `plot_${randomUUID().slice(0, 8)}` };
  const sizeError = oversized(data);
  if (sizeError) return { ok: false, error: sizeError };
  return { ok: true, artifact: { kind: "plot", data } };
}

export function buildDiagramArtifact(args: DiagramArgs): { ok: true; artifact: Artifact } | { ok: false; error: string } {
  const ids = args.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "节点 id 不能重复" };
  const known = new Set(ids);
  for (const edge of args.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) {
      return { ok: false, error: `连线 ${edge.from} -> ${edge.to} 引用了不存在的节点 id` };
    }
    if (edge.from === edge.to) return { ok: false, error: "连线不能指向自身" };
  }
  const data: DiagramArtifactData = { ...args, version: SPEC_VERSION, id: `diagram_${randomUUID().slice(0, 8)}` };
  const sizeError = oversized(data);
  if (sizeError) return { ok: false, error: sizeError };
  return { ok: true, artifact: { kind: "diagram", data } };
}

export function buildChartArtifact(args: ChartArgs): { ok: true; artifact: Artifact } | { ok: false; error: string } {
  if (args.categories.length === 0) return { ok: false, error: "categories 不能为空" };
  if (args.series.length === 0) return { ok: false, error: "至少需要 1 组 series" };
  if (args.series.length > MAX_CHART_SERIES) return { ok: false, error: `series 最多 ${MAX_CHART_SERIES} 组` };
  if (args.chartType === "pie" && args.series.length !== 1) {
    return { ok: false, error: "饼图（pie）只能有 1 组 series；多组数据请改用 bar / line" };
  }
  for (const series of args.series) {
    if (series.values.length !== args.categories.length) {
      return {
        ok: false,
        error: `series「${series.name}」有 ${series.values.length} 个值，但 categories 有 ${args.categories.length} 个，两者必须等长`,
      };
    }
    for (const value of series.values) {
      if (!Number.isFinite(value)) return { ok: false, error: `series「${series.name}」含有非有限数值（NaN / Infinity）` };
      if (Math.abs(value) > 1e12) return { ok: false, error: `series「${series.name}」的数值超出 ±1e12` };
    }
  }
  const data: ChartArtifactData = { ...args, version: SPEC_VERSION, id: `chart_${randomUUID().slice(0, 8)}` };
  const sizeError = oversized(data);
  if (sizeError) return { ok: false, error: sizeError };
  return { ok: true, artifact: { kind: "chart", data } };
}

export function buildComparisonArtifact(
  args: ComparisonArgs,
): { ok: true; artifact: Artifact } | { ok: false; error: string } {
  if (args.items.length < 2) return { ok: false, error: "对比至少需要 2 个对比项" };
  if (args.items.length > MAX_COMPARISON_ITEMS) {
    return { ok: false, error: `对比项最多 ${MAX_COMPARISON_ITEMS} 个（当前 ${args.items.length} 个）` };
  }
  const names = args.items.map((item) => item.name);
  if (new Set(names).size !== names.length) return { ok: false, error: "对比项 name 不能重复" };
  const data: ComparisonArtifactData = { ...args, version: SPEC_VERSION, id: `comparison_${randomUUID().slice(0, 8)}` };
  const sizeError = oversized(data);
  if (sizeError) return { ok: false, error: sizeError };
  return { ok: true, artifact: { kind: "comparison", data } };
}

/** Keep a turn's persisted artifacts bounded (per-turn byte/count caps). */
export function capArtifacts(artifacts: Artifact[]): Artifact[] {
  const kept: Artifact[] = [];
  let bytes = 0;
  for (const artifact of artifacts) {
    if (kept.length >= MAX_ARTIFACTS_PER_TURN) break;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(artifact), "utf8");
    } catch {
      continue;
    }
    if (bytes + size > MAX_ARTIFACT_BYTES_PER_TURN) break;
    bytes += size;
    kept.push(artifact);
  }
  return kept;
}
