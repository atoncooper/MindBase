"use client";

// Pan/zoom renderer for AI-generated diagrams.
//
// The model emits a node/edge spec (the subset of a drawio/mxGraph diagram that
// generated flowcharts actually need); the client renders it as SVG with the
// same interaction model as a diagram viewer: wheel zoom around the cursor,
// drag to pan, "fit" to frame the whole drawing. No external viewer bundle is
// needed for this subset, so it works offline and inherits the app theme.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiagramNodeSpec, DiagramSpec } from "@/lib/artifacts/interactive-spec";

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const NODE_W = 156;
const NODE_H = 56;
const FIT_PAD = 28;

const TONES: Record<string, { fill: string; stroke: string; text: string }> = {
  default: { fill: "#ffffff", stroke: "#d2d2d7", text: "#1d1d1f" },
  accent: { fill: "#eef4fd", stroke: "#0071e3", text: "#0b4f9e" },
  success: { fill: "#edfaf1", stroke: "#34c759", text: "#1c7a3a" },
  warning: { fill: "#fff7e8", stroke: "#ff9f0a", text: "#8a5a00" },
};

function nodeBox(node: DiagramNodeSpec) {
  const w = node.w ?? NODE_W;
  const h = node.h ?? NODE_H;
  return { x: node.x, y: node.y, w, h, cx: node.x + w / 2, cy: node.y + h / 2 };
}

function glyphWidth(ch: string, fontSize: number): number {
  // CJK glyphs are full-width, latin/digits roughly 0.58em in the UI font.
  return /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.58;
}

/** Word-aware wrapping with a width budget (CJK breaks per character). */
function wrapLabel(label: string, maxWidth: number, fontSize = 12.5): string[] {
  const out: string[] = [];
  const tokens = (text: string): string[] => text.match(/[A-Za-z0-9_.+\-/]+|\s+|./gu) ?? [text];
  for (const paragraph of label.split("\n")) {
    let line = "";
    let lineWidth = 0;
    const flush = () => {
      if (line.trim()) out.push(line.trim());
      line = "";
      lineWidth = 0;
    };
    for (const token of tokens(paragraph)) {
      const width = Array.from(token).reduce((sum, ch) => sum + glyphWidth(ch, fontSize), 0);
      if (lineWidth + width <= maxWidth) {
        line += token;
        lineWidth += width;
        continue;
      }
      flush();
      if (width <= maxWidth) {
        line = token;
        lineWidth = width;
        continue;
      }
      // A single token wider than the node: hard-break it character by character.
      for (const ch of Array.from(token)) {
        const cw = glyphWidth(ch, fontSize);
        if (lineWidth + cw > maxWidth) flush();
        line += ch;
        lineWidth += cw;
      }
    }
    flush();
  }
  return out.slice(0, 4);
}

/** Point on the node boundary towards (tx, ty) — keeps arrowheads off the text. */
function boundaryPoint(node: DiagramNodeSpec, towardX: number, towardY: number) {
  const box = nodeBox(node);
  const dx = towardX - box.cx;
  const dy = towardY - box.cy;
  const hw = box.w / 2 + 2;
  const hh = box.h / 2 + 2;
  const len = Math.hypot(dx, dy) || 1;
  const sx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const sy = Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(sx, sy);
  return { x: box.cx + (dx / len) * t * len, y: box.cy + (dy / len) * t * len };
}

export function DiagramView({ spec, height = 320 }: { spec: DiagramSpec; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tf, setTf] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ px: number; py: number; start: Transform } | null>(null);
  const fittedRef = useRef(false);

  const bounds = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of spec.nodes) {
      const box = nodeBox(node);
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    return {
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    };
  }, [spec]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.w === 0 || size.h === 0) return;
    const scale = Math.min(
      (size.w - FIT_PAD * 2) / bounds.w,
      (size.h - FIT_PAD * 2) / bounds.h,
      1.4,
    );
    setTf({
      scale,
      tx: (size.w - bounds.w * scale) / 2 - bounds.x * scale,
      ty: (size.h - bounds.h * scale) / 2 - bounds.y * scale,
    });
  }, [bounds, size]);

  useEffect(() => {
    if (fittedRef.current || size.w === 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, size.w]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0012);
      setTf((prev) => {
        const scale = Math.min(3, Math.max(0.15, prev.scale * factor));
        const k = scale / prev.scale;
        return { scale, tx: mx - (mx - prev.tx) * k, ty: my - (my - prev.ty) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { px: event.clientX, py: event.clientY, start: tf };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setTf({
      scale: drag.start.scale,
      tx: drag.start.tx + (event.clientX - drag.px),
      ty: drag.start.ty + (event.clientY - drag.py),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const zoomBy = (factor: number) => {
    setTf((prev) => {
      const scale = Math.min(3, Math.max(0.15, prev.scale * factor));
      const k = scale / prev.scale;
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { scale, tx: cx - (cx - prev.tx) * k, ty: cy - (cy - prev.ty) * k };
    });
  };

  const nodeById = useMemo(() => {
    const map = new Map<string, DiagramNodeSpec>();
    for (const node of spec.nodes) map.set(node.id, node);
    return map;
  }, [spec]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div
          ref={containerRef}
          className="relative w-full cursor-grab touch-none overflow-hidden rounded-xl border border-border-subtle bg-[#fbfbfd] active:cursor-grabbing"
          style={{ height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <svg width={size.w} height={size.h} className="block">
            <defs>
              <pattern id="diagram-dots" width="18" height="18" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#e3e3e8" />
              </pattern>
              <marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#86868b" />
              </marker>
            </defs>
            <rect width={size.w} height={size.h} fill="url(#diagram-dots)" />
            <g transform={`translate(${tf.tx} ${tf.ty}) scale(${tf.scale})`}>
              {spec.edges.map((edge, i) => {
                const from = nodeById.get(edge.from);
                const to = nodeById.get(edge.to);
                if (!from || !to) return null;
                const a = nodeBox(from);
                const b = nodeBox(to);
                const start = boundaryPoint(from, b.cx, b.cy);
                const end = boundaryPoint(to, a.cx, a.cy);
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const horizontal = Math.abs(dx) >= Math.abs(dy);
                const c1 = horizontal
                  ? { x: start.x + dx * 0.5, y: start.y }
                  : { x: start.x, y: start.y + dy * 0.5 };
                const c2 = horizontal
                  ? { x: end.x - dx * 0.5, y: end.y }
                  : { x: end.x, y: end.y - dy * 0.5 };
                const mid = {
                  x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * end.x,
                  y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * end.y,
                };
                return (
                  <g key={`${edge.from}-${edge.to}-${i}`}>
                    <path
                      d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`}
                      fill="none"
                      stroke="#a1a1a6"
                      strokeWidth={1.4}
                      strokeDasharray={edge.dashed ? "5 4" : undefined}
                      markerEnd="url(#diagram-arrow)"
                    />
                    {edge.label && (
                      <text
                        x={mid.x}
                        y={mid.y - 6}
                        textAnchor="middle"
                        fontSize={11}
                        fill="#86868b"
                        style={{ paintOrder: "stroke", stroke: "#fbfbfd", strokeWidth: 4, strokeLinejoin: "round" }}
                      >
                        {edge.label}
                      </text>
                    )}
                  </g>
                );
              })}
              {spec.nodes.map((node) => {
                const box = nodeBox(node);
                const tone = TONES[node.tone ?? "default"] ?? TONES.default;
                const lines = wrapLabel(node.label, box.w - 18);
                const lineH = 15;
                const startY = box.cy - ((lines.length - 1) * lineH) / 2;
                return (
                  <g key={node.id}>
                    {node.shape === "ellipse" ? (
                      <ellipse cx={box.cx} cy={box.cy} rx={box.w / 2} ry={box.h / 2} fill={tone.fill} stroke={tone.stroke} strokeWidth={1.4} />
                    ) : node.shape === "diamond" ? (
                      <polygon
                        points={`${box.cx},${box.y} ${box.x + box.w},${box.cy} ${box.cx},${box.y + box.h} ${box.x},${box.cy}`}
                        fill={tone.fill}
                        stroke={tone.stroke}
                        strokeWidth={1.4}
                      />
                    ) : (
                      <rect
                        x={box.x}
                        y={box.y}
                        width={box.w}
                        height={box.h}
                        rx={node.shape === "rect" ? 8 : 16}
                        fill={tone.fill}
                        stroke={tone.stroke}
                        strokeWidth={1.4}
                      />
                    )}
                    {lines.map((line, i) => (
                      <text
                        key={i}
                        x={box.cx}
                        y={startY + i * lineH}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={12.5}
                        fill={tone.text}
                      >
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            className="grid h-6 w-6 place-items-center rounded-md border border-border-subtle bg-white/90 text-secondary backdrop-blur transition-colors hover:text-foreground"
            aria-label="放大"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            className="grid h-6 w-6 place-items-center rounded-md border border-border-subtle bg-white/90 text-secondary backdrop-blur transition-colors hover:text-foreground"
            aria-label="缩小"
          >
            −
          </button>
          <button
            type="button"
            onClick={fit}
            className="rounded-md border border-border-subtle bg-white/90 px-1.5 py-0.5 text-[11px] text-secondary backdrop-blur transition-colors hover:text-foreground"
          >
            适应
          </button>
        </div>
      </div>
      <p className="text-[11px] text-tertiary">滚轮缩放 · 拖拽平移 · 「适应」重新框选全图</p>
    </div>
  );
}
