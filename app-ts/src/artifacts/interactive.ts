import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Artifact } from "../context/types.js";

/**
 * Interactive artifact specs (plot / diagram).
 *
 * The model emits a small, fully declarative JSON spec — never HTML or JS —
 * and the web client renders it with trusted components (canvas / SVG).
 * This module is the server-side contract: zod schemas shown to the model,
 * plus cross-field checks that zod alone cannot express (unique node ids,
 * edge endpoints, expression identifiers, payload size).
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

export type PlotArgs = z.infer<typeof plotArgsSchema>;
export type DiagramArgs = z.infer<typeof diagramArgsSchema>;

export type PlotArtifactData = PlotArgs & { version: number; id: string };
export type DiagramArtifactData = DiagramArgs & { version: number; id: string };

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
