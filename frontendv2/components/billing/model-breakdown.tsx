"use client";

import type { ModelUsage } from "@/lib/api";
import { formatTokens, formatCost, formatNum } from "./format";

/** Per-model usage bars - sorted by cost, each row a model with a proportional bar. */
export function ModelBreakdown({ data }: { data: ModelUsage[] }) {
    const sorted = [...data].sort((a, b) => b.cost_estimate - a.cost_estimate);
    const maxCost = Math.max(1, ...sorted.map((d) => d.cost_estimate));

    return (
        <div className="rounded-lg border border-border-subtle bg-surface p-5">
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                按模型
            </h3>
            {sorted.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-[13px] text-tertiary">
                    暂无数据
                </div>
            ) : (
                <div className="mt-4 space-y-4">
                    {sorted.map((m) => {
                        const pct = (m.cost_estimate / maxCost) * 100;
                        return (
                            <div
                                key={`${m.provider}/${m.model}`}
                                className="grid grid-cols-[1fr_auto] items-center gap-4"
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-[13px] font-medium text-foreground">
                                            {m.model}
                                        </span>
                                        <span className="shrink-0 rounded bg-border-subtle px-1.5 py-0.5 text-[10px] text-tertiary">
                                            {m.provider}
                                        </span>
                                    </div>
                                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
                                        <div
                                            className="h-full rounded-full bg-foreground"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                    <div className="mt-1.5 text-[11px] text-tertiary">
                                        {formatTokens(m.total_tokens)} tokens ·{" "}
                                        {formatNum(m.api_calls)} 次
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-[14px] font-semibold text-foreground">
                                        {formatCost(m.cost_estimate)}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
