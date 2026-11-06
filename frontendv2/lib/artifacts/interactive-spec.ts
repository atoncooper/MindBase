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

export type InteractiveSpec = PlotSpec | DiagramSpec;

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

export function specByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
