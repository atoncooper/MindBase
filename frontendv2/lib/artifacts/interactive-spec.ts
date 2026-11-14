// Declarative specs for interactive chat artifacts (plot / diagram).
//
// The model emits a small JSON spec; the client validates it and renders a
// trusted React component (canvas / SVG). Nothing executable is involved, so
// these kinds can render in the chat page without an iframe sandbox.
//
// Limits mirror app-ts/src/artifacts/interactive.ts (server-side validation).

export const SPEC_VERSION = 1;
export const MAX_SPEC_BYTES = 32 * 1024;
export const MAX_CURVES = 4;
export const MAX_PARAMS = 8;
export const MAX_NODES = 60;
export const MAX_EDGES = 120;
// Interactive artifact limits (chart / comparison) — must stay in sync with
// app-ts/src/artifacts/interactive.ts.
export const MAX_CHART_CATEGORIES = 24;
export const MAX_CHART_SERIES = 6;
export const MAX_COMPARISON_ITEMS = 4;

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
  version?: number;
  id?: string;
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
  version?: number;
  id?: string;
  title: string;
  nodes: DiagramNodeSpec[];
  edges: DiagramEdgeSpec[];
}

export type ChartType = "bar" | "line" | "pie";

export interface ChartSeriesSpec {
  name: string;
  values: number[];
}

export interface ChartSpec {
  version?: number;
  id?: string;
  title: string;
  subtitle?: string;
  chartType: ChartType;
  categories: string[];
  series: ChartSeriesSpec[];
  unit?: string;
  xLabel?: string;
  yLabel?: string;
}

export interface ComparisonAttrSpec {
  label: string;
  value: string;
}

export interface ComparisonItemSpec {
  name: string;
  summary?: string;
  pros?: string[];
  cons?: string[];
  attrs?: ComparisonAttrSpec[];
}

export interface ComparisonSpec {
  version?: number;
  id?: string;
  title: string;
  subtitle?: string;
  items: ComparisonItemSpec[];
  recommendation?: string;
}

export type InteractiveSpec = PlotSpec | DiagramSpec | ChartSpec | ComparisonSpec;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Structural guard: enough to render safely; the server has already enforced the tight limits. */
export function isPlotSpec(value: unknown): value is PlotSpec {
  if (!record(value)) return false;
  const s = value as unknown as PlotSpec;
  return (
    typeof s.title === "string" &&
    finite(s.xMin) &&
    finite(s.xMax) &&
    s.xMax > s.xMin &&
    Array.isArray(s.curves) &&
    s.curves.length > 0 &&
    s.curves.length <= MAX_CURVES &&
    s.curves.every((c) => record(c) && typeof c.expr === "string" && c.expr.length > 0 && c.expr.length <= 300) &&
    (s.params === undefined ||
      (Array.isArray(s.params) &&
        s.params.length <= MAX_PARAMS &&
        s.params.every(
          (p) =>
            record(p) &&
            typeof p.name === "string" &&
            finite(p.min) &&
            finite(p.max) &&
            finite(p.step) &&
            finite(p.value) &&
            p.max > p.min,
        )))
  );
}

export function isDiagramSpec(value: unknown): value is DiagramSpec {
  if (!record(value)) return false;
  const s = value as unknown as DiagramSpec;
  return (
    typeof s.title === "string" &&
    Array.isArray(s.nodes) &&
    s.nodes.length > 0 &&
    s.nodes.length <= MAX_NODES &&
    s.nodes.every(
      (n) =>
        record(n) &&
        typeof n.id === "string" &&
        typeof n.label === "string" &&
        finite(n.x) &&
        finite(n.y),
    ) &&
    Array.isArray(s.edges) &&
    s.edges.length <= MAX_EDGES &&
    s.edges.every((e) => record(e) && typeof e.from === "string" && typeof e.to === "string")
  );
}

const CHART_TYPES: readonly ChartType[] = ["bar", "line", "pie"];

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Structural guard: enough to render safely; the server has already enforced the tight limits. */
export function isChartSpec(value: unknown): value is ChartSpec {
  if (!record(value)) return false;
  const s = value as unknown as ChartSpec;
  if (typeof s.title !== "string" || s.title.length === 0) return false;
  if (!CHART_TYPES.includes(s.chartType)) return false;
  if (!optionalString(s.subtitle) || !optionalString(s.unit) || !optionalString(s.xLabel) || !optionalString(s.yLabel)) {
    return false;
  }
  if (!Array.isArray(s.categories) || s.categories.length === 0 || s.categories.length > MAX_CHART_CATEGORIES) {
    return false;
  }
  if (!s.categories.every((category) => typeof category === "string" && category.length > 0)) return false;
  if (!Array.isArray(s.series) || s.series.length === 0 || s.series.length > MAX_CHART_SERIES) return false;
  if (s.chartType === "pie" && s.series.length !== 1) return false;
  const categoryCount = s.categories.length;
  return s.series.every(
    (series) =>
      record(series) &&
      typeof series.name === "string" &&
      series.name.length > 0 &&
      Array.isArray(series.values) &&
      series.values.length === categoryCount &&
      series.values.every((v) => finite(v) && Math.abs(v) <= 1e12),
  );
}

export function isComparisonSpec(value: unknown): value is ComparisonSpec {
  if (!record(value)) return false;
  const s = value as unknown as ComparisonSpec;
  if (typeof s.title !== "string" || s.title.length === 0) return false;
  if (!optionalString(s.subtitle) || !optionalString(s.recommendation)) return false;
  if (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > MAX_COMPARISON_ITEMS) return false;
  const names = new Set<string>();
  for (const item of s.items) {
    if (!record(item)) return false;
    if (typeof item.name !== "string" || item.name.length === 0) return false;
    if (names.has(item.name)) return false;
    names.add(item.name);
    if (!optionalString(item.summary)) return false;
    if (item.pros !== undefined && !stringArray(item.pros)) return false;
    if (item.cons !== undefined && !stringArray(item.cons)) return false;
    if (
      item.attrs !== undefined &&
      (!Array.isArray(item.attrs) ||
        !item.attrs.every((attr) => record(attr) && typeof attr.label === "string" && typeof attr.value === "string"))
    ) {
      return false;
    }
  }
  return true;
}

export function specByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
