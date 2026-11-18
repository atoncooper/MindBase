"use client";

/**
 * ChatModelPicker - 聊天输入栏的统一模型选择器。
 *
 * 弹层分两个互斥分组：
 *   - 系统模型：config/model.json（GET /chat/models），全部经平台 AI 网关；
 *     「默认模型」不传 model，由后端 config.llm.model 决定。
 *   - Coding Plan：当前用户最早启用的第三方套餐（VIP/SVIP），模型列表在
 *     首次切到该分组时按需探测（GET /settings/coding-plans/{id}/models），
 *     走用户自己的套餐额度。
 *
 * 选中 Coding Plan 模型时请求携带 coding_plan_model 且不携带 model；选中
 * 系统模型/默认模型时清空 coding_plan_model。二者不会同时发送。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, Check, ChevronDown, Loader2 } from "lucide-react";
import {
    codingPlanApi,
    type ChatModel,
    type CodingPlan,
} from "@/lib/api";

/** 一次模型选择：默认 / 系统目录模型 / Coding Plan 模型。 */
export type ChatModelSelection =
    | { kind: "default" }
    | { kind: "system"; id: string }
    | { kind: "coding-plan"; model: string };

type Tab = "system" | "coding";

export function ChatModelPicker({
    models,
    value,
    codingPlanValue,
    onChange,
    disabled = false,
}: {
    models: ChatModel[];
    /** 系统模型目录 id；"" = 默认模型（请求不带 model） */
    value: string;
    /** 当前选中的 Coding Plan 模型；undefined = 未使用 Coding Plan */
    codingPlanValue?: string;
    onChange: (selection: ChatModelSelection) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>("system");
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [plan, setPlan] = useState<CodingPlan | null>(null);
    const [codingModels, setCodingModels] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    // 厂商不提供 /models 时：保留配置的默认模型，只给一条弱提示，不报红。
    const [modelsNotice, setModelsNotice] = useState<string | null>(null);
    // 403 = 非 VIP：整个 Coding Plan 分组隐藏，避免每次打开都提示"不可用"。
    const [forbidden, setForbidden] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Esc / 点击外部关闭。
    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const loadCodingPlan = useCallback(async () => {
        setLoading(true);
        setError(null);
        setModelsNotice(null);
        setForbidden(false);
        try {
            const { plans } = await codingPlanApi.list();
            // 与后端 FirstEnabled 一致：最早创建的启用套餐。
            const active = plans.find((p) => p.enabled) ?? null;
            setPlan(active);
            if (!active) {
                setCodingModels([]);
                return;
            }
            let probed: string[] = [];
            try {
                const catalog = await codingPlanApi.models(active.id);
                probed = catalog.models ?? [];
            } catch (e) {
                // 探测失败仍保留配置里的默认模型，用户可以先试；
                // 有默认模型时用弱提示，不把"厂商没有 /models"渲染成红色错误。
                if (active.model) {
                    setModelsNotice("该套餐未返回模型列表，使用默认模型");
                } else {
                    setError(e instanceof Error ? e.message : "模型列表加载失败");
                }
            }
            const merged = Array.from(
                new Set([active.model, ...probed].map((m) => m.trim()).filter(Boolean)),
            );
            setCodingModels(merged);
        } catch (e) {
            const status = (e as { status?: number })?.status;
            // 403 = 非 VIP：静默隐藏 Coding Plan 分组，不影响系统模型。
            if (status === 403) {
                setForbidden(true);
            } else {
                setError(e instanceof Error ? e.message : "Coding Plan 加载失败");
            }
            setPlan(null);
            setCodingModels([]);
        } finally {
            setLoading(false);
            setLoaded(true);
        }
    }, []);

    const toggle = () => {
        if (disabled) return;
        const next = !open;
        setOpen(next);
        if (next) {
            setTab(codingPlanValue ? "coding" : "system");
            if (!loaded && !loading) void loadCodingPlan();
        }
    };

    const selectTab = (next: Tab) => {
        setTab(next);
        if (next === "coding" && !loaded && !loading) void loadCodingPlan();
    };

    const selectedSystem = models.find((m) => m.id === value);
    // 触发按钮只显示模型 id（套餐名在弹层里），避免长标签挤爆输入栏。
    const label = codingPlanValue ?? selectedSystem?.label ?? "默认模型";
    const activeTab: Tab = forbidden ? "system" : tab;

    return (
        <div ref={rootRef} className="relative shrink-0">
            <button
                type="button"
                onClick={toggle}
                disabled={disabled}
                aria-expanded={open}
                aria-haspopup="true"
                aria-label={`选择聊天模型（当前：${label}）`}
                title="选择聊天模型：系统默认模型或 Coding Plan 模型"
                className="flex h-8 max-w-[150px] items-center gap-1 rounded-md px-2 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50 sm:max-w-[220px]"
            >
                {codingPlanValue && (
                    <Boxes className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                )}
                <span className="hidden shrink-0 sm:inline">
                    {codingPlanValue ? "套餐" : "模型"}
                </span>
                <span className="truncate">{label}</span>
                <ChevronDown
                    className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                />
            </button>

            {open && (
                <div
                    role="group"
                    aria-label="聊天模型选择"
                    className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[90vw] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
                >
                    <div className="border-b border-border-subtle px-3 py-2">
                        <div className="text-[12px] font-medium text-foreground">选择模型</div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
                            系统模型走平台网关；Coding Plan 使用你配置的套餐额度
                        </div>
                        {!forbidden && (
                            <div
                                role="tablist"
                                aria-label="模型来源"
                                className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-[#f1f3f4] p-1"
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={activeTab === "system"}
                                    onClick={() => selectTab("system")}
                                    className={`h-7 rounded-md text-[11px] font-medium transition-colors ${
                                        activeTab === "system"
                                            ? "bg-surface text-foreground shadow-sm"
                                            : "text-secondary hover:text-foreground"
                                    }`}
                                >
                                    系统模型
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={activeTab === "coding"}
                                    onClick={() => selectTab("coding")}
                                    className={`h-7 rounded-md text-[11px] font-medium transition-colors ${
                                        activeTab === "coding"
                                            ? "bg-surface text-foreground shadow-sm"
                                            : "text-secondary hover:text-foreground"
                                    }`}
                                >
                                    Coding Plan
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="max-h-[320px] overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {activeTab === "system" ? (
                            <>
                                <button
                                    type="button"
                                    aria-pressed={!codingPlanValue && !selectedSystem}
                                    onClick={() => {
                                        onChange({ kind: "default" });
                                        setOpen(false);
                                    }}
                                    className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-border-subtle/60 ${
                                        !codingPlanValue && !selectedSystem ? "bg-accent-soft/60" : ""
                                    }`}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[12px] font-medium text-foreground">
                                            默认模型
                                        </span>
                                        <span className="mt-0.5 block text-[11px] leading-relaxed text-tertiary">
                                            跟随服务端基础模型配置
                                        </span>
                                    </span>
                                    {!codingPlanValue && !selectedSystem && (
                                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                    )}
                                </button>

                                {models.map((model) => {
                                    const active = !codingPlanValue && model.id === value;
                                    return (
                                        <button
                                            key={model.id}
                                            type="button"
                                            aria-pressed={active}
                                            onClick={() => {
                                                onChange({ kind: "system", id: model.id });
                                                setOpen(false);
                                            }}
                                            className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-border-subtle/60 ${
                                                active ? "bg-accent-soft/60" : ""
                                            }`}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-1.5">
                                                    <span className="truncate text-[12px] font-medium text-foreground">
                                                        {model.label}
                                                    </span>
                                                    {model.vision && (
                                                        <span className="shrink-0 rounded-sm bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                                            视觉
                                                        </span>
                                                    )}
                                                </span>
                                                {model.description && (
                                                    <span className="mt-0.5 block text-[11px] leading-relaxed text-tertiary">
                                                        {model.description}
                                                    </span>
                                                )}
                                            </span>
                                            {active && (
                                                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                            )}
                                        </button>
                                    );
                                })}
                            </>
                        ) : (
                            <>
                                <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-1">
                                    <span className="text-[11px] font-medium text-tertiary">
                                        Coding Plan
                                    </span>
                                    <span className="min-w-0 truncate text-[10px] text-tertiary">
                                        {plan?.label || (loaded && !loading ? "未配置" : "")}
                                    </span>
                                </div>

                                {loading && (
                                    <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-tertiary">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        正在读取套餐模型…
                                    </div>
                                )}

                                {!loading && error && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-danger">
                                        {error}
                                        <button
                                            type="button"
                                            onClick={() => void loadCodingPlan()}
                                            className="ml-1 font-medium underline underline-offset-2"
                                        >
                                            重试
                                        </button>
                                    </div>
                                )}

                                {!loading && modelsNotice && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                                        {modelsNotice}
                                    </div>
                                )}

                                {!loading && plan && codingModels.length === 0 && (
                                    <div className="px-3 py-2 text-[11px] text-tertiary">
                                        该套餐没有返回可用模型
                                    </div>
                                )}

                                {!loading &&
                                    codingModels.map((model) => {
                                        const active = codingPlanValue === model;
                                        return (
                                            <button
                                                key={model}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => {
                                                    onChange({ kind: "coding-plan", model });
                                                    setOpen(false);
                                                }}
                                                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-border-subtle/60 ${
                                                    active ? "bg-accent-soft/60" : ""
                                                }`}
                                            >
                                                <span className="flex min-w-0 items-center gap-1.5">
                                                    <Boxes className="h-3 w-3 shrink-0 text-tertiary" aria-hidden="true" />
                                                    <span className="truncate font-mono text-[11px] text-foreground">
                                                        {model}
                                                    </span>
                                                </span>
                                                {active && (
                                                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                                )}
                                            </button>
                                        );
                                    })}

                                {!loading && loaded && !plan && !error && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                                        未检测到可用 Coding Plan
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {activeTab === "coding" && !forbidden && (
                        <div className="border-t border-border-subtle px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                            选择 Coding Plan 模型会消耗套餐额度；套餐不可用时自动回退平台模型。
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
