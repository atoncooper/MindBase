"use client";

/**
 * 分析 Tab：生成结果表（academic_analysis）。
 *
 * 后端把项目实验运行汇总成 Markdown 结果表，并尽力上传到学术空间
 * 04_结果/results_summary.md；这里渲染 Markdown 原文与上传位置信息。
 * 不引入 Markdown 依赖，用等宽 pre 保留表格排版。
 */
import { useState } from "react";
import { Loader2, Table2 } from "lucide-react";
import { academicApi, type AcademicAnalysisChart, type AcademicAnalysisResult } from "@/lib/api";
import { EmptyState, ErrorBanner, LoadingBlock } from "./research-ui";

const SERIES_COLORS = ["#0071e3", "#f5a623", "#34c759", "#ff3b30", "#af52de", "#5ac8fa"];

/** 轻量 SVG 对比柱状图：不引入图表依赖，按指标系列分组展示。 */
function CompareChart({ chart }: { chart: AcademicAnalysisChart }) {
    if (chart.categories.length === 0 || chart.series.length === 0) return null;
    const width = 760;
    const height = 300;
    const pad = { left: 44, right: 16, top: 16, bottom: 64 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const max = Math.max(1, ...chart.series.flatMap((series) => series.values));
    const groupWidth = plotWidth / chart.categories.length;
    const barWidth = Math.max(4, Math.min(24, (groupWidth * 0.7) / chart.series.length));
    return (
        <div className="rounded-xl border border-border-subtle bg-surface p-3">
            <h3 className="text-[13px] font-medium text-foreground">指标对比</h3>
            <div className="mt-2 overflow-x-auto">
                <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full min-w-[560px]" role="img" aria-label="多 run 指标对比">
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                        <line
                            key={ratio}
                            x1={pad.left}
                            x2={width - pad.right}
                            y1={pad.top + plotHeight * (1 - ratio)}
                            y2={pad.top + plotHeight * (1 - ratio)}
                            stroke="#e5e5ea"
                            strokeWidth={1}
                        />
                    ))}
                    {chart.categories.map((category, categoryIndex) => {
                        const groupX = pad.left + groupWidth * categoryIndex;
                        return (
                            <g key={category}>
                                {chart.series.map((series, seriesIndex) => {
                                    const value = series.values[categoryIndex] ?? 0;
                                    const barHeight = (value / max) * plotHeight;
                                    const x = groupX + (groupWidth - barWidth * chart.series.length) / 2 + seriesIndex * barWidth;
                                    return (
                                        <rect
                                            key={series.name}
                                            x={x}
                                            y={pad.top + plotHeight - barHeight}
                                            width={Math.max(1, barWidth - 2)}
                                            height={Math.max(1, barHeight)}
                                            fill={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
                                            rx={2}
                                        />
                                    );
                                })}
                                <text
                                    x={groupX + groupWidth / 2}
                                    y={height - pad.bottom + 18}
                                    textAnchor="middle"
                                    fontSize={10}
                                    fill="#6e6e73"
                                >
                                    {category.length > 14 ? category.slice(0, 14) + "…" : category}
                                </text>
                            </g>
                        );
                    })}
                    <text x={pad.left - 8} y={pad.top + 4} textAnchor="end" fontSize={10} fill="#6e6e73">
                        {max.toFixed(2)}
                    </text>
                    <text x={pad.left - 8} y={pad.top + plotHeight} textAnchor="end" fontSize={10} fill="#6e6e73">
                        0
                    </text>
                </svg>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {chart.series.map((series, index) => (
                    <span key={series.name} className="inline-flex items-center gap-1 text-[11px] text-secondary">
                        <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
                        />
                        {series.name}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function AnalysisTab({ projectId }: { projectId: string }) {
    const [result, setResult] = useState<AcademicAnalysisResult | null>(null);
    const [mode, setMode] = useState<"summary" | "compare">("summary");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generate = async () => {
        setBusy(true);
        setError(null);
        try {
            setResult(await academicApi.generateResults(projectId, { mode }));
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成结果表失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-[640px] min-w-0 flex-1 text-[12px] leading-relaxed text-secondary">
                    把项目的实验运行汇总为结果表（Markdown），并尽力上传到学术空间
                    <span className="font-mono text-[11px] text-tertiary"> 04_结果/results_summary.md </span>
                    ；生成后可直接粘贴进论文「结果」章节。
                </p>
                <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                    <select
                        value={mode}
                        disabled={busy}
                        onChange={(e) => setMode(e.target.value as "summary" | "compare")}
                        aria-label="分析模式"
                        className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[12px] text-foreground outline-none sm:w-[140px]"
                    >
                        <option value="summary">结果表</option>
                        <option value="compare">多 run 对比</option>
                    </select>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void generate()}
                        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
                    >
                        {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Table2 className="h-3.5 w-3.5" />
                        )}
                        {mode === "compare" ? "生成对比" : "生成结果表"}
                    </button>
                </div>
            </div>

            {error && <ErrorBanner message={error} onRetry={() => void generate()} />}

            {busy && !result ? (
                <LoadingBlock label="生成结果表…" />
            ) : result === null ? (
                <EmptyState
                    icon={Table2}
                    title="还没有生成结果表"
                    description="点击「生成结果表」，后端会汇总已记录实验运行并返回 Markdown 结果表。"
                />
            ) : (
                <div className="space-y-3">
                    <div className="rounded-xl border border-border-subtle bg-surface p-4">
                        <p className="text-[12px] text-secondary">
                            {result.uploadUuid
                                ? "已上传到学术空间 04_结果/results_summary.md"
                                : "已生成结果表，但未能上传到云盘（云盘可能暂不可用）。"}
                        </p>
                        {result.uploadUuid && (
                            <p className="mt-1 break-all text-[11px] text-tertiary">
                                uploadUuid：
                                <span className="font-mono">{result.uploadUuid}</span>
                                {result.folderId !== undefined
                                    ? ` · folderId: ${result.folderId}`
                                    : ""}
                            </p>
                        )}
                    </div>

                    {result.chart && <CompareChart chart={result.chart} />}

                    <div className="rounded-xl border border-border-subtle bg-surface">
                        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
                            <h3 className="text-[13px] font-medium text-foreground">结果表 Markdown</h3>
                            <span className="text-[11px] text-tertiary">
                                {result.markdown.length} 字符
                            </span>
                        </div>
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-secondary">
                            {result.markdown}
                        </pre>
                    </div>
                </div>
            )}
        </div>
    );
}
