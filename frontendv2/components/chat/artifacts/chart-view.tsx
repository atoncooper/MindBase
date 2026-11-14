"use client";

// Declarative data-chart renderer (pure SVG, no chart dependency).
//
// Reads a validated ChartSpec and draws grouped bars, one or more lines, or a
// pie. The SVG is laid out against the measured container width so tick labels
// keep a stable pixel size, and the same numbers are exposed as a native
// <details> table for screen readers / copy & paste. Colors come from the app
// palette; nothing here is executable, so the chat page can render it inline
// without an iframe sandbox.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartSpec } from "@/lib/artifacts/interactive-spec";

const PALETTE = ["#0071e3", "#ff9f0a", "#34c759", "#ff3b30", "#5e5ce6", "#00c7be"];
const PAD = { left: 52, right: 16, top: 14, bottom: 30 };
const GRID = "#eeeef2";
const AXIS = "#d2d2d7";
const TICK_TEXT = "#86868b";

interface YDomain {
  y0: number;
  y1: number;
  ticks: number[];
}

interface PieSlice {
  value: number;
  fraction: number;
  start: number;
  end: number;
}

function trimNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** Compact tick formatting: 12.4k / 3.2M, matching the axis budget. */
function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trimNumber(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimNumber(value / 1e6)}M`;
  if (abs >= 1e3) return `${trimNumber(value / 1e3)}k`;
  return trimNumber(value);
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const normalized = raw / magnitude;
  const multiplier = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return multiplier * magnitude;
}

/** Y axis always includes the zero baseline; all-zero input still gets ticks. */
function buildYDomain(values: number[]): YDomain {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 0;
  }
  lo = Math.min(lo, 0);
  hi = Math.max(hi, 0);
  if (hi - lo < 1e-9) hi = lo + 1;
  const step = niceStep(hi - lo, 4);
  const y0 = Math.floor(lo / step) * step;
  const y1 = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const count = Math.min(12, Math.round((y1 - y0) / step));
  for (let i = 0; i <= count; i += 1) ticks.push(Number((y0 + i * step).toPrecision(12)));
  return { y0, y1, ticks };
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

function plainNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : trimNumber(value);
}

function valueLabel(spec: ChartSpec, category: string, seriesName: string | null, value: number): string {
  const unit = spec.unit ? ` ${spec.unit}` : "";
  const prefix = seriesName ? `${category} · ${seriesName}` : category;
  return `${prefix}: ${plainNumber(value)}${unit}`;
}

function typeLabel(spec: ChartSpec): string {
  if (spec.chartType === "bar") return "柱状图";
  if (spec.chartType === "line") return "折线图";
  return "饼图";
}

export function ChartView({ spec, height = 320 }: { spec: ChartSpec; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const values = useMemo(() => spec.series.flatMap((series) => series.values), [spec]);
  const domain = useMemo(() => buildYDomain(values), [values]);

  const categoryCount = spec.categories.length;
  const seriesCount = spec.series.length;
  const chartW = Math.max(1, width);
  const plotW = Math.max(20, chartW - PAD.left - PAD.right);
  const plotH = Math.max(20, height - PAD.top - PAD.bottom);
  const bandW = plotW / Math.max(1, categoryCount);
  const ySpan = domain.y1 - domain.y0 || 1;
  const toY = (value: number) => PAD.top + ((domain.y1 - value) / ySpan) * plotH;

  const pieValues = spec.series[0]?.values ?? [];
  const pieTotal = pieValues.reduce((sum, value) => sum + Math.max(0, value), 0);
  const pieSlices = pieValues.reduce<PieSlice[]>((acc, value) => {
    const previous = acc.length > 0 ? acc[acc.length - 1] : null;
    const start = previous ? previous.end : -Math.PI / 2;
    const safe = Math.max(0, value);
    const fraction = pieTotal > 0 ? safe / pieTotal : 0;
    acc.push({ value: safe, fraction, start, end: start + fraction * Math.PI * 2 });
    return acc;
  }, []);

  const pieCx = chartW / 2;
  const pieCy = height / 2;
  const pieRadius = Math.max(20, Math.min(chartW, height) / 2 - 18);
  const showPieEmpty = spec.chartType === "pie" && pieTotal <= 0;

  const ariaLabel = `${spec.title}，${typeLabel(spec)}，${categoryCount} 个类别，${seriesCount} 组数据`;

  const yAxisLabel = spec.yLabel ?? spec.unit;
  const rotateLabels = categoryCount > 8;
  // Keep dense category axes readable: rotated labels get the width budget the
  // band actually offers instead of a fixed character cap.
  const categoryLabelMax = rotateLabels
    ? Math.max(6, Math.min(14, Math.floor(bandW / 5)))
    : Math.max(3, Math.min(10, Math.floor(bandW / 7) + 2));

  const legend =
    spec.chartType === "pie"
      ? spec.categories.map((category, index) => {
          const fraction = pieTotal > 0 ? Math.max(0, pieValues[index] ?? 0) / pieTotal : 0;
          return (
            <span key={`legend-${index}`} className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-secondary">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[index % PALETTE.length] }} />
              <span className="truncate">{truncate(category, 18)}</span>
              <span className="shrink-0 tabular-nums text-tertiary">{(fraction * 100).toFixed(1)}%</span>
            </span>
          );
        })
      : spec.series.map((series, index) => (
          <span key={`legend-${index}`} className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-secondary">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[index % PALETTE.length] }} />
            <span className="truncate">{series.name}</span>
          </span>
        ));

  const tableHead =
    spec.chartType === "pie"
      ? ["类别", `数值${spec.unit ? `（${spec.unit}）` : ""}`, "占比"]
      : ["类别", ...spec.series.map((series) => `${series.name}${spec.unit ? `（${spec.unit}）` : ""}`)];
  const tableRows =
    spec.chartType === "pie"
      ? spec.categories.map((category, index) => {
          const value = pieValues[index] ?? 0;
          return [category, plainNumber(value), pieTotal > 0 ? `${((Math.max(0, value) / pieTotal) * 100).toFixed(1)}%` : "—"];
        })
      : spec.categories.map((category, index) => [
          category,
          ...spec.series.map((series) => plainNumber(series.values[index] ?? 0)),
        ]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{legend}</div>

      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-xl border border-border-subtle bg-white"
        style={{ height }}
      >
        {width > 0 && (
          <svg width={chartW} height={height} role="img" aria-label={ariaLabel} className="block">
            <title>{ariaLabel}</title>

            {spec.chartType === "pie" ? (
              <g>
                {pieSlices.map((slice, index) => {
                  const mid = (slice.start + slice.end) / 2;
                  const labelRadius = pieRadius * 0.66;
                  const labelX = pieCx + Math.cos(mid) * labelRadius;
                  const labelY = pieCy + Math.sin(mid) * labelRadius;
                  const color = PALETTE[index % PALETTE.length];
                  const title = <title>{valueLabel(spec, spec.categories[index] ?? "", null, slice.value)}</title>;
                  const showLabel = slice.fraction >= 0.07;
                  return (
                    <g key={`slice-${index}`}>
                      {slice.fraction >= 0.999 ? (
                        <circle cx={pieCx} cy={pieCy} r={pieRadius} fill={color}>
                          {title}
                        </circle>
                      ) : slice.fraction > 0 ? (
                        <path
                          d={describeArc(pieCx, pieCy, pieRadius, slice.start, slice.end)}
                          fill={color}
                          stroke="#ffffff"
                          strokeWidth={1}
                        >
                          {title}
                        </path>
                      ) : null}
                      {showLabel && (
                        <text
                          x={labelX}
                          y={labelY}
                          dy="0.32em"
                          textAnchor="middle"
                          fontSize={10.5}
                          fontWeight={500}
                          fill="#ffffff"
                          style={{ pointerEvents: "none" }}
                        >
                          {Math.round(slice.fraction * 100)}%
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ) : (
              <g>
                {domain.ticks.map((tick) => {
                  const y = toY(tick);
                  return (
                    <g key={`tick-${tick}`}>
                      <line
                        x1={PAD.left}
                        x2={PAD.left + plotW}
                        y1={y}
                        y2={y}
                        stroke={Math.abs(tick) < 1e-9 ? AXIS : GRID}
                        strokeWidth={1}
                      />
                      <text x={PAD.left - 7} y={y} dy="0.32em" textAnchor="end" fontSize={10.5} fill={TICK_TEXT}>
                        {formatCompact(tick)}
                      </text>
                    </g>
                  );
                })}

                {spec.categories.map((category, index) => {
                  const x = PAD.left + (index + 0.5) * bandW;
                  const y = PAD.top + plotH + 12;
                  return (
                    <text
                      key={`category-${index}`}
                      x={x}
                      y={y}
                      fontSize={10.5}
                      fill={TICK_TEXT}
                      textAnchor={rotateLabels ? "end" : "middle"}
                      transform={rotateLabels ? `rotate(-28 ${x} ${y})` : undefined}
                    >
                      {truncate(category, categoryLabelMax)}
                      <title>{category}</title>
                    </text>
                  );
                })}

                {yAxisLabel && (
                  <text
                    x={12}
                    y={PAD.top + plotH / 2}
                    textAnchor="middle"
                    fontSize={10.5}
                    fill={TICK_TEXT}
                    transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}
                  >
                    {truncate(yAxisLabel, 20)}
                  </text>
                )}
                {spec.xLabel && (
                  <text x={PAD.left + plotW} y={height - 2} textAnchor="end" fontSize={10.5} fill={TICK_TEXT}>
                    {truncate(spec.xLabel, 20)}
                  </text>
                )}

                {spec.chartType === "bar"
                  ? spec.series.map((series, seriesIndex) => {
                      const innerW = bandW * 0.72;
                      const barW = Math.max(1, innerW / Math.max(1, seriesCount));
                      const color = PALETTE[seriesIndex % PALETTE.length];
                      return (
                        <g key={`bars-${seriesIndex}`}>
                          {series.values.map((value, index) => {
                            const zeroY = toY(0);
                            const valueY = toY(value);
                            const x = PAD.left + index * bandW + (bandW - innerW) / 2 + seriesIndex * barW;
                            return (
                              <rect
                                key={`bar-${seriesIndex}-${index}`}
                                x={x}
                                y={Math.min(zeroY, valueY)}
                                width={Math.max(1, barW - 1)}
                                height={Math.abs(valueY - zeroY)}
                                rx={2}
                                fill={color}
                              >
                                <title>{valueLabel(spec, spec.categories[index] ?? "", series.name, value)}</title>
                              </rect>
                            );
                          })}
                        </g>
                      );
                    })
                  : spec.series.map((series, seriesIndex) => {
                      const color = PALETTE[seriesIndex % PALETTE.length];
                      const points = series.values
                        .map((value, index) => `${PAD.left + (index + 0.5) * bandW},${toY(value)}`)
                        .join(" ");
                      return (
                        <g key={`line-${seriesIndex}`}>
                          {series.values.length > 1 && (
                            <polyline
                              points={points}
                              fill="none"
                              stroke={color}
                              strokeWidth={2}
                              strokeLinejoin="round"
                              strokeLinecap="round"
                            />
                          )}
                          {series.values.map((value, index) => (
                            <circle
                              key={`dot-${seriesIndex}-${index}`}
                              cx={PAD.left + (index + 0.5) * bandW}
                              cy={toY(value)}
                              r={2.6}
                              fill="#ffffff"
                              stroke={color}
                              strokeWidth={1.8}
                            >
                              <title>{valueLabel(spec, spec.categories[index] ?? "", series.name, value)}</title>
                            </circle>
                          ))}
                        </g>
                      );
                    })}
              </g>
            )}
          </svg>
        )}

        {(categoryCount === 0 || seriesCount === 0 || showPieEmpty) && (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-tertiary">
            {showPieEmpty ? "暂无有效数据（数值均为 0）" : "暂无数据"}
          </div>
        )}
      </div>

      <details className="group/details text-[11px]">
        <summary className="w-fit cursor-pointer select-none text-secondary transition-colors hover:text-foreground">
          数据表
        </summary>
        <div className="mt-1.5 max-h-56 overflow-auto rounded-lg border border-border-subtle">
          <table className="w-full border-collapse text-left text-[11px]">
            <caption className="sr-only">{`数据表：${spec.title}`}</caption>
            <thead>
              <tr className="bg-[#f5f5f7]">
                {tableHead.map((cell) => (
                  <th key={cell} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium text-secondary">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`} className="border-t border-border-subtle">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`cell-${rowIndex}-${cellIndex}`}
                      className={`px-2 py-1.5 ${cellIndex === 0 ? "text-foreground" : "tabular-nums text-secondary"}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Pie sector path; the full-circle case is handled by the caller with a <circle>. */
function describeArc(cx: number, cy: number, r: number, start: number, end: number): string {
  const safeEnd = Math.min(end, start + Math.PI * 2 - 1e-4);
  const largeArc = safeEnd - start > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(start);
  const y0 = cy + r * Math.sin(start);
  const x1 = cx + r * Math.cos(safeEnd);
  const y1 = cy + r * Math.sin(safeEnd);
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
}
