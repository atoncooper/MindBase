"use client";

/**
 * UsageView - billing/usage dashboard (OpenAI-style, Apple monochrome).
 *
 * Layout: range switcher -> 4 stat cards -> SVG trend chart (tokens/cost/calls)
 * -> per-model breakdown. Data loads in parallel on range change.
 */
import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import {
    billingApi,
    type UsageSummary,
    type UsageTimeseriesPoint,
    type ModelUsage,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatTokens, formatCost, formatNum } from "./format";
import { StatCard } from "./stat-card";
import { UsageChart } from "./usage-chart";
import { ModelBreakdown } from "./model-breakdown";

const RANGES = [
    { days: 7, label: "近 7 天" },
    { days: 30, label: "近 30 天" },
    { days: 90, label: "近 90 天" },
];

export function UsageView() {
    const [days, setDays] = useState(30);
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [timeseries, setTimeseries] = useState<UsageTimeseriesPoint[]>([]);
    const [byModel, setByModel] = useState<ModelUsage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const [s, t, m] = await Promise.all([
                    billingApi.getSummary(days),
                    billingApi.getTimeseries(days),
                    billingApi.getByModel(days),
                ]);
                if (cancelled) return;
                setSummary(s);
                setTimeseries(t);
                setByModel(m);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [days]);

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8 sm:px-10">
            <header className="flex items-center justify-between">
                <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
                    用量计费
                </h1>
                <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                    {RANGES.map((r) => (
                        <button
                            key={r.days}
                            type="button"
                            onClick={() => setDays(r.days)}
                            className={cn(
                                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                                days === r.days
                                    ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
                                    : "text-secondary hover:text-foreground",
                            )}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
            </header>

            {error ? (
                <div className="mt-8 flex items-center gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-4 py-3 text-[13px] text-foreground">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            ) : loading ? (
                <div className="mt-16 flex items-center justify-center gap-2 text-[13px] text-tertiary">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载中…
                </div>
            ) : summary ? (
                <>
                    <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                        <StatCard
                            label="总花费"
                            value={formatCost(summary.total_cost)}
                            sub={`次均 ${formatCost(summary.avg_cost_per_call)}`}
                        />
                        <StatCard
                            label="总 Tokens"
                            value={formatTokens(summary.total_tokens)}
                            sub={`提示 ${formatTokens(summary.total_prompt_tokens)} / 补全 ${formatTokens(summary.total_completion_tokens)}`}
                        />
                        <StatCard
                            label="API 调用"
                            value={formatNum(summary.total_api_calls)}
                        />
                        <StatCard
                            label="模型数"
                            value={String(summary.by_model.length)}
                            sub={`凭证 ${summary.by_credential.length}`}
                        />
                    </section>

                    <section className="mt-5">
                        <UsageChart data={timeseries} />
                    </section>

                    <section className="mt-5">
                        <ModelBreakdown data={byModel} />
                    </section>
                </>
            ) : null}
        </div>
    );
}
