"use client";

/**
 * 六阶段步骤条：当前阶段高亮，阶段状态用颜色/图标区分
 * （locked 灰 / active 蓝 / submitted 橙 / approved 绿 / frozen 深灰）。
 *
 * 纯展示组件；点击某阶段只用于切换「当前查看阶段」（可选回调），不会写后端。
 */
import { Check, Clock, Circle, Lock, Snowflake } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AcademicStage, AcademicStageState } from "@/lib/api";
import { STAGE_LABELS, STAGE_ORDER } from "./research-ui";

const STATUS_DOT: Record<string, string> = {
    locked: "border-border text-tertiary",
    active: "border-accent bg-accent text-white",
    submitted: "border-warning text-warning",
    approved: "border-success bg-success text-white",
    frozen: "border-tertiary bg-border text-secondary",
};

function StepIcon({ state }: { state: AcademicStageState }) {
    const cls = "h-3 w-3";
    switch (state.status) {
        case "approved":
            return <Check className={cls} />;
        case "submitted":
            return <Clock className={cls} />;
        case "active":
            return <Circle className={cn(cls, "fill-current")} />;
        case "frozen":
            return <Snowflake className={cls} />;
        default:
            return <Lock className={cls} />;
    }
}

export function StageStepper({
    stages,
    current,
    selected,
    onSelect,
}: {
    stages: Record<AcademicStage, AcademicStageState>;
    current: AcademicStage;
    selected?: AcademicStage;
    onSelect?: (stage: AcademicStage) => void;
}) {
    return (
        <div className="flex items-start gap-1 overflow-x-auto pb-1">
            {STAGE_ORDER.map((stage, index) => {
                const state = stages[stage];
                const isCurrent = stage === current;
                const isSelected = stage === selected;
                const active = isSelected || (!selected && isCurrent);
                const next = STAGE_ORDER[index + 1];
                return (
                    <div key={stage} className="flex min-w-0 flex-1 items-start">
                        <button
                            type="button"
                            onClick={onSelect ? () => onSelect(stage) : undefined}
                            disabled={!onSelect}
                            title={state?.note || STAGE_LABELS[stage]}
                            className={cn(
                                "group flex min-w-[74px] flex-col items-center gap-1.5 rounded-lg px-1 py-1 transition-colors",
                                onSelect && "hover:bg-border-subtle/60",
                                !onSelect && "cursor-default",
                            )}
                        >
                            <span
                                className={cn(
                                    "grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold transition-colors",
                                    STATUS_DOT[state?.status ?? "locked"],
                                    active && "ring-2 ring-accent/30",
                                )}
                            >
                                {state?.status === "locked" ? index + 1 : <StepIcon state={state} />}
                            </span>
                            <span
                                className={cn(
                                    "whitespace-nowrap text-[11px] leading-tight",
                                    isCurrent ? "font-semibold text-foreground" : "text-secondary",
                                )}
                            >
                                {STAGE_LABELS[stage]}
                            </span>
                            {isCurrent && <span className="text-[10px] text-accent">当前</span>}
                        </button>
                        {next && (
                            <div
                                className={cn(
                                    "mt-3.5 h-px min-w-3 flex-1",
                                    state?.status === "approved" ? "bg-success/50" : "bg-border",
                                )}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
