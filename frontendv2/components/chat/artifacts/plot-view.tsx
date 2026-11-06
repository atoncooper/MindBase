"use client";

// Interactive function-plot renderer (canvas, no chart dependency).
//
// Reads a declarative PlotSpec: curves are expressions over x plus named
// parameters; the sliders below the canvas re-evaluate them live. Wheel zooms
// around the pointer, drag pans, double-click re-fits the y range.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compileExpr, type EvalFn } from "@/lib/artifacts/expr";
import type { PlotSpec } from "@/lib/artifacts/interactive-spec";

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const FALLBACK_COLORS = ["#0071e3", "#ff9f0a", "#34c759", "#af52de", "#ff3b30"];
const PAD = { left: 44, right: 14, top: 12, bottom: 26 };

function niceStep(span: number, target = 6): number {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return mult * mag;
}

function fmtTick(v: number, step: number): string {
  const digits = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  const s = v.toFixed(digits);
  return s === "-0" || s === "-0.0" ? "0" : s;
}

export function PlotView({ spec, height = 300 }: { spec: PlotSpec; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [params, setParams] = useState<Record<string, number>>(() => initialParams(spec));
  const [view, setView] = useState<Box>(() => ({
    x0: spec.xMin,
    x1: spec.xMax,
    y0: -3,
    y1: 3,
  }));
  const fittedRef = useRef(false);
  const dragRef = useRef<{ px: number; py: number; box: Box } | null>(null);

  const compiled = useMemo(() => {
    const names = (spec.params ?? []).map((p) => p.name);
    return spec.curves.map((curve, i) => {
      const color = curve.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
      try {
        return { ...curve, color, fn: compileExpr(curve.expr, names), error: null as string | null };
      } catch (err) {
        return {
          ...curve,
          color,
          fn: null as EvalFn | null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }, [spec]);

  // Size the backing store to the CSS box (device-pixel-ratio aware).
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

  const fitY = useCallback(
    (box: Box): Box => {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const curve of compiled) {
        if (!curve.fn) continue;
        for (let i = 0; i <= 400; i += 1) {
          const x = box.x0 + ((box.x1 - box.x0) * i) / 400;
          const y = curve.fn(x, params);
          if (!Number.isFinite(y) || Math.abs(y) > 1e6) continue;
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ...box, y0: -3, y1: 3 };
      if (Math.abs(hi - lo) < 1e-6) {
        lo -= 1;
        hi += 1;
      }
      const pad = (hi - lo) * 0.12;
      return { ...box, y0: lo - pad, y1: hi + pad };
    },
    [compiled, params],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const plotW = Math.max(10, size.w - PAD.left - PAD.right);
    const plotH = Math.max(10, size.h - PAD.top - PAD.bottom);
    const { x0, x1, y0, y1 } = view;
    const toX = (x: number) => PAD.left + ((x - x0) / (x1 - x0)) * plotW;
    const toY = (y: number) => PAD.top + ((y1 - y) / (y1 - y0)) * plotH;

    // Grid
    const stepX = niceStep(x1 - x0);
    const stepY = niceStep(y1 - y0);
    ctx.lineWidth = 1;
    ctx.font = "11px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let x = Math.ceil(x0 / stepX) * stepX; x <= x1; x += stepX) {
      const px = toX(x);
      ctx.strokeStyle = Math.abs(x) < stepX / 2 ? "#c7c7cc" : "#eeeef2";
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + plotH);
      ctx.stroke();
      ctx.fillStyle = "#86868b";
      ctx.fillText(fmtTick(x, stepX), px, PAD.top + plotH + 6);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let y = Math.ceil(y0 / stepY) * stepY; y <= y1; y += stepY) {
      const py = toY(y);
      ctx.strokeStyle = Math.abs(y) < stepY / 2 ? "#c7c7cc" : "#eeeef2";
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = "#86868b";
      ctx.fillText(fmtTick(y, stepY), PAD.left - 7, py);
    }

    // Curves
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const curve of compiled) {
      if (!curve.fn) continue;
      ctx.strokeStyle = curve.color;
      ctx.beginPath();
      let started = false;
      let prevY = 0;
      const samples = Math.max(240, Math.floor(plotW * 1.5));
      for (let i = 0; i <= samples; i += 1) {
        const x = x0 + ((x1 - x0) * i) / samples;
        const y = curve.fn(x, params);
        const px = toX(x);
        const py = toY(y);
        const bad = !Number.isFinite(y) || Math.abs(y - y0) > (y1 - y0) * 50;
        if (bad || (started && Math.abs(py - toY(prevY)) > plotH * 4)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
        prevY = y;
      }
      ctx.stroke();
    }
    ctx.restore();
  }, [compiled, params, size, view]);

  useEffect(() => {
    draw();
  }, [draw]);

  // First meaningful y range comes from the data, not from a fixed default.
  useEffect(() => {
    if (fittedRef.current || size.w === 0) return;
    fittedRef.current = true;
    setView((box) => fitY(box));
  }, [fitY, size.w]);

  // Wheel zoom (non-passive so the page does not scroll while zooming).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const plotW = Math.max(10, rect.width - PAD.left - PAD.right);
      const plotH = Math.max(10, rect.height - PAD.top - PAD.bottom);
      const fx = Math.min(1, Math.max(0, (mx - PAD.left) / plotW));
      const fy = Math.min(1, Math.max(0, (my - PAD.top) / plotH));
      const factor = Math.exp(event.deltaY * 0.0012);
      setView((box) => {
        const ax = box.x0 + (box.x1 - box.x0) * fx;
        const ay = box.y1 + (box.y0 - box.y1) * fy;
        const next = {
          x0: ax + (box.x0 - ax) * factor,
          x1: ax + (box.x1 - ax) * factor,
          y0: ay + (box.y0 - ay) * factor,
          y1: ay + (box.y1 - ay) * factor,
        };
        const spanX = next.x1 - next.x0;
        if (spanX < 1e-4 || spanX > 1e6) return box;
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { px: event.clientX, py: event.clientY, box: view };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const plotW = Math.max(10, size.w - PAD.left - PAD.right);
    const plotH = Math.max(10, size.h - PAD.top - PAD.bottom);
    const dx = ((event.clientX - drag.px) / plotW) * (drag.box.x1 - drag.box.x0);
    const dy = ((event.clientY - drag.py) / plotH) * (drag.box.y1 - drag.box.y0);
    setView({
      x0: drag.box.x0 - dx,
      x1: drag.box.x1 - dx,
      y0: drag.box.y0 + dy,
      y1: drag.box.y1 + dy,
    });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const reset = () => {
    const base: Box = { x0: spec.xMin, x1: spec.xMax, y0: view.y0, y1: view.y1 };
    setView(fitY({ ...base, y0: -3, y1: 3 }));
  };

  const updateParam = (name: string, value: number) => {
    setParams((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {compiled.map((curve) => (
          <span key={curve.expr + (curve.label ?? "")} className="inline-flex items-center gap-1.5 text-[11px] text-secondary">
            <span className="h-2 w-2 rounded-full" style={{ background: curve.color }} />
            <span className="font-mono text-[11px] text-foreground">{curve.label ?? curve.expr}</span>
            {curve.error && <span className="text-danger">（{curve.error}）</span>}
          </span>
        ))}
      </div>

      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl border border-border-subtle bg-white"
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
        />
        <button
          type="button"
          onClick={reset}
          className="absolute right-2 top-2 rounded-md border border-border-subtle bg-white/90 px-1.5 py-0.5 text-[11px] text-secondary backdrop-blur transition-colors hover:text-foreground"
        >
          复位
        </button>
      </div>

      {(spec.params ?? []).length > 0 && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {(spec.params ?? []).map((param) => {
            const value = params[param.name] ?? param.value;
            return (
              <label key={param.name} className="flex items-center gap-2.5">
                <span className="w-16 shrink-0 text-[12px] text-secondary">{param.label ?? param.name}</span>
                <input
                  type="range"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={value}
                  onChange={(e) => updateParam(param.name, Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border-subtle"
                  style={{ accentColor: "#0071e3" }}
                />
                <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
                  {value.toFixed(2)}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-tertiary">滚轮缩放 · 拖拽平移 · 双击图像复位</p>
    </div>
  );
}

function initialParams(spec: PlotSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of spec.params ?? []) out[param.name] = param.value;
  return out;
}
