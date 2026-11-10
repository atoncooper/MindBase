"use client";

/**
 * CodingPlanModelPicker - chat input model selector for the user's Coding Plan.
 *
 * The plan stores credentials only; the model catalog is probed on demand when
 * the user opens this picker (never at save time). Selecting a model sends
 * coding_plan_model with the chat turn; the code agent uses it for that run.
 * Free users / users without an enabled plan see nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, Check, ChevronDown, Loader2 } from "lucide-react";
import { codingPlanApi, type CodingPlan } from "@/lib/api";

interface Props {
    value?: string;
    onChange: (model: string | undefined) => void;
}

export function CodingPlanModelPicker({ value, onChange }: Props) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [plan, setPlan] = useState<CodingPlan | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Outside click closes the popover.
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [open]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const plans = await codingPlanApi.list();
            const active = plans.find((p) => p.enabled) ?? null;
            setPlan(active);
            if (!active) {
                setModels([]);
                return;
            }
            const catalog = await codingPlanApi.models(active.id);
            setModels(catalog.models ?? []);
            if (!value && catalog.models?.length) onChange(catalog.models[0]);
        } catch (e) {
            const status = (e as { status?: number })?.status;
            // 403 = non-VIP; the picker simply stays hidden, no error noise.
            if (status !== 403) setError(e instanceof Error ? e.message : "模型列表加载失败");
            setPlan(null);
            setModels([]);
        } finally {
            setLoading(false);
            setLoaded(true);
        }
    }, [onChange, value]);

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && !plan && !loading) void load();
    };

    // No enabled plan and no explicit selection: nothing to show.
    if (loaded && !plan && !value) return null;

    return (
        <div ref={rootRef} className="relative shrink-0">
            <button
                type="button"
                onClick={toggle}
                aria-haspopup="listbox"
                aria-expanded={open}
                title="选择本轮所有 Agent 使用的 Coding Plan 模型"
                className="flex h-8 max-w-[150px] items-center gap-1 rounded-md px-2 text-[12px] text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
            >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Boxes className="h-3.5 w-3.5" />}
                <span className="truncate">{value || "模型"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
            </button>

            {open && (
                <div className="absolute bottom-full right-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_8px_28px_rgba(0,0,0,0.14)]">
                    <div className="border-b border-border-subtle px-3 py-2">
                        <div className="text-[12px] font-medium text-foreground">
                            {plan ? plan.label || "Coding Plan" : "Coding Plan"}
                        </div>
                        <div className="mt-0.5 text-[11px] text-tertiary">
                            {plan ? "本轮所有 Agent 使用所选模型" : "未检测到可用套餐"}
                        </div>
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                        {loading && (
                            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-tertiary">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                正在读取套餐模型…
                            </div>
                        )}
                        {!loading && error && (
                            <div className="px-3 py-3 text-[12px] text-danger">{error}</div>
                        )}
                        {!loading && !error && models.length === 0 && (
                            <div className="px-3 py-3 text-[12px] text-tertiary">该套餐没有返回可用模型</div>
                        )}
                        {!loading &&
                            models.map((model) => {
                                const selected = model === value;
                                return (
                                    <button
                                        key={model}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        onClick={() => {
                                            onChange(model);
                                            setOpen(false);
                                        }}
                                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-border-subtle/60"
                                    >
                                        <span className="truncate font-mono">{model}</span>
                                        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                                    </button>
                                );
                            })}
                    </div>
                    <div className="border-t border-border-subtle px-3 py-2 text-[11px] text-tertiary">
                        模型列表由套餐服务商实时提供；作用于主 Agent 与子 Agent
                    </div>
                </div>
            )}
        </div>
    );
}
