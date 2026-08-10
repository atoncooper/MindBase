"use client";

import { useState } from "react";
import type { UsageTimeseriesPoint } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatTokens, formatCost, formatNum } from "./format";

type Metric = "total_tokens" | "cost_estimate" | "api_calls";

const METRICS: { key: Metric; label: string; format: (v: number) => string }[] = [
    { key: "total_tokens", label: "Tokens", format: formatTokens },
    { key: "cost_estimate", label: "花费", format: formatCost },
    { key: "api_calls", label: "调用", format: formatNum },
];

// SVG viewBox dims - the chart scales to container width preserving aspect ratio.
const W = 1000;
const H = 280;
const PAD_L = 56;
const PAD_R = 20;
const PAD_T = 16;
const PAD_B = 32;

const C_FG = "var(--color-foreground)";
const C_BORDER = "var(--color-border)";
const C_SURFACE = "var(--color-surface)";
const C_TERTIARY = "var(--color-tertiary)";

/** Round v up to a nice 1/2/5 * 10^n ceiling so y-axis ticks read cleanly. */
function niceCeiling(v: number): number {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    let nice: number;
    if (f <= 1) nice = 1;
    else if (f <= 2) nice = 2;
    else if (f <= 5) nice = 5;
    else nice = 10;
    return nice * base;
}

function pickLabelIndices(n: number): number[] {
    if (n <= 1) return [0];
    if (n <= 7) return Array.from({ length: n }, (_, i) => i);
    return [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
}

function fmtDate(date: string): string {
    const m = date.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return date;
    return `${m[2]}/${m[3]}`;
}

export function UsageChart({ data }: { data: UsageTimeseriesPoint[] }) {
    const [metric, setMetric] = useState<Metric>("total_tokens");
    const [hover, setHover] = useState<number | null>(null);

    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;
    const active = METRICS.find((m) => m.key === metric)!;

    const values = data.map((d) => d[metric]);
    const maxV = Math.max(1, ...values);
    const niceMax = niceCeiling(maxV);

    const x = (i: number) =>
        PAD_L + (data.length <= 1 ? chartW / 2 : (i / (data.length - 1)) * chartW);
    const y = (v: number) => PAD_T + chartH - (v / niceMax) * chartH;

    const linePath = data
        .map(
            (d, i) =>
                `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[metric]).toFixed(1)}`,
        )
        .join(" ");
    const areaPath =
        data.length > 0
            ? `${linePath} L${x(data.length - 1).toFixed(1)},${(PAD_T + chartH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + chartH).toFixed(1)} Z`
            : "";

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
        v: niceMax * t,
        y: y(niceMax * t),
    }));
    const labelIndices = pickLabelIndices(data.length);

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (data.length === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const idx = Math.round(((px - PAD_L) / chartW) * (data.length - 1));
        if (idx >= 0 && idx < data.length) setHover(idx);
    };

    const hoverPt = hover !== null && data[hover] ? data[hover] : null;
    const tooltipW = 120;
    const tooltipX =
        hover !== null
            ? Math.min(Math.max(x(hover) - tooltipW / 2, PAD_L), W - PAD_R - tooltipW)
            : 0;

    return (
        <div className="rounded-lg border border-border-subtle bg-surface p-5">
            <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                    用量趋势
                </h3>
                <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                    {METRICS.map((m) => (
                        <button
                            key={m.key}
                            type="button"
                            onClick={() => setMetric(m.key)}
                            className={cn(
                                "rounded-md px-3 py-1 text-[11px] font-medium transition-colors",
                                metric === m.key
                                    ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
                                    : "text-secondary hover:text-foreground",
                            )}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mt-4">
                {data.length === 0 ? (
                    <div className="flex h-[220px] items-center justify-center text-[13px] text-tertiary">
                        暂无数据
                    </div>
                ) : (
                    <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className="w-full"
                        style={{ height: "auto" }}
                        onMouseMove={onMove}
                        onMouseLeave={() => setHover(null)}
                    >
                        <defs>
                            <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={C_FG} stopOpacity="0.14" />
                                <stop offset="100%" stopColor={C_FG} stopOpacity="0" />
                            </linearGradient>
                        </defs>

                        {/* grid + y labels */}
                        {ticks.map((t, i) => (
                            <g key={i}>
                                <line
                                    x1={PAD_L}
                                    y1={t.y}
                                    x2={W - PAD_R}
                                    y2={t.y}
                                    stroke={C_BORDER}
                                    strokeWidth="1"
                                />
                                <text
                                    x={PAD_L - 10}
                                    y={t.y + 4}
                                    textAnchor="end"
                                    style={{ fontSize: 11, fill: C_TERTIARY }}
                                >
                                    {active.format(t.v)}
                                </text>
                            </g>
                        ))}

                        {/* area + line */}
                        <path d={areaPath} fill="url(#usage-area)" />
                        <path
                            d={linePath}
                            fill="none"
                            stroke={C_FG}
                            strokeWidth="2"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                        />

                        {/* x labels */}
                        {labelIndices.map((i) => (
                            <text
                                key={i}
                                x={x(i)}
                                y={H - 10}
                                textAnchor="middle"
                                style={{ fontSize: 11, fill: C_TERTIARY }}
                            >
                                {fmtDate(data[i].date)}
                            </text>
                        ))}

                        {/* hover guide + point + tooltip */}
                        {hoverPt && hover !== null && (
                            <g>
                                <line
                                    x1={x(hover)}
                                    y1={PAD_T}
                                    x2={x(hover)}
                                    y2={PAD_T + chartH}
                                    stroke={C_BORDER}
                                    strokeWidth="1"
                                    strokeDasharray="3 3"
                                />
                                <circle
                                    cx={x(hover)}
                                    cy={y(hoverPt[metric])}
                                    r="4.5"
                                    fill={C_FG}
                                    stroke={C_SURFACE}
                                    strokeWidth="2"
                                />
                                <g transform={`translate(${tooltipX}, ${PAD_T})`}>
                                    <rect
                                        x="0"
                                        y="0"
                                        width={tooltipW}
                                        height="42"
                                        rx="8"
                                        fill={C_FG}
                                    />
                                    <text
                                        x="10"
                                        y="17"
                                        style={{ fontSize: 11, fill: C_SURFACE }}
                                    >
                                        {fmtDate(hoverPt.date)}
                                    </text>
                                    <text
                                        x="10"
                                        y="33"
                                        style={{
                                            fontSize: 12,
                                            fontWeight: 600,
                                            fill: C_SURFACE,
                                        }}
                                    >
                                        {active.format(hoverPt[metric])}
                                    </text>
                                </g>
                            </g>
                        )}
                    </svg>
                )}
            </div>
        </div>
    );
}
