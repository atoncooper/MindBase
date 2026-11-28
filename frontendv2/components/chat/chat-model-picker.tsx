"use client";

/**
 * ChatModelPicker - 聊天输入栏的统一模型选择器。
 *
 * 弹层分两个互斥分组：
 *   - 系统模型：config/model.json（GET /chat/models），全部经平台 AI 网关；
 *     「默认模型」不传 model，由后端 config.llm.model 决定。
 *   - Coding Plan：用户启用的第三方套餐（VIP/SVIP）。套餐目录由 ChatView 在
 *     挂载时统一加载，并通过 ChatModelPickerProvider 注入（避免选择器重复请求、
 *     也避免「先显示平台默认、套餐到了再跳变」）；套餐模型列表在首次切到该
 *     分组时按需探测（GET /settings/coding-plans/{id}/models）。
 *
 * 默认选择优先级（由 ChatView 计算）：用户显式选择 > is_default 的 Coding Plan
 * 套餐默认模型 > 平台默认模型。选中 Coding Plan 模型时请求携带 coding_plan_model
 * 且不携带 model；平台默认两者都不传；二者不会同时发送。
 */
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { Boxes, Check, ChevronDown, Loader2 } from "lucide-react";
import { EffortSlider, REASONING_EFFORT_DEFAULT, reasoningEffortLabel, type ReasoningEffort } from "./effort-slider";
import { codingPlanApi, type ChatModel, type CodingPlan } from "@/lib/api";

/** 一次模型选择：默认 / 系统目录模型 / Coding Plan 模型。 */
export type ChatModelSelection =
    | { kind: "default" }
    | { kind: "system"; id: string }
    | { kind: "coding-plan"; model: string };

/**
 * ChatView 统一加载的模型/套餐上下文。选择器只负责展示与切换：
 * 目录/套餐的加载、默认选择的裁决、请求字段的互斥都在 ChatView 完成。
 */
export interface ChatModelPickerContextValue {
    /** 目录/套餐尚未加载完成：触发器显示中性加载态，避免先显示平台默认再跳变。 */
    loading: boolean;
    /** 当前展示的套餐（is_default 优先，其次最早启用）；null = 没有可用套餐。 */
    plan: CodingPlan | null;
    /** is_default 的启用套餐：决定聊天默认模型与「Coding Plan 默认」标记。 */
    defaultPlan: CodingPlan | null;
    /** 403（非 VIP）：整个 Coding Plan 分组静默隐藏。 */
    forbidden: boolean;
}

const ChatModelPickerContext = createContext<ChatModelPickerContextValue | null>(null);

/** 由 ChatView 渲染在 ChatInput 外层：选择器在 ChatInput 内部，无法透传 props。 */
export function ChatModelPickerProvider({
    value,
    children,
}: {
    value: ChatModelPickerContextValue;
    children: ReactNode;
}) {
    return (
        <ChatModelPickerContext.Provider value={value}>{children}</ChatModelPickerContext.Provider>
    );
}

function useChatModelPickerContext(): ChatModelPickerContextValue {
    const value = useContext(ChatModelPickerContext);
    if (!value) {
        throw new Error("ChatModelPicker 必须在 ChatModelPickerProvider 内渲染");
    }
    return value;
}

type Tab = "system" | "coding";

export function ChatModelPicker({
    models,
    value,
    codingPlanValue,
    onChange,
    reasoningEffort = REASONING_EFFORT_DEFAULT,
    onReasoningEffortChange,
    disabled = false,
}: {
    models: ChatModel[];
    /** 系统模型目录 id；"" = 默认模型（请求不带 model） */
    value: string;
    /** 当前选中的 Coding Plan 模型；undefined = 未使用 Coding Plan */
    codingPlanValue?: string;
    onChange: (selection: ChatModelSelection) => void;
    /** 推理强度（弹层底部滑动变阻器） */
    reasoningEffort?: ReasoningEffort;
    onReasoningEffortChange?: (value: ReasoningEffort) => void;
    disabled?: boolean;
}) {
    const { loading, plan, defaultPlan, forbidden } = useChatModelPickerContext();
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<Tab>("system");
    // 套餐模型列表：null = 还未探测（首次打开 Coding Plan 分组时才回源）。
    const [probedModels, setProbedModels] = useState<string[] | null>(null);
    const [probeLoading, setProbeLoading] = useState(false);
    const [probeError, setProbeError] = useState<string | null>(null);
    // 厂商不提供 /models 时：保留配置的默认模型，只给一条弱提示，不报红。
    const [probeNotice, setProbeNotice] = useState<string | null>(null);
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

    const loadCodingModels = useCallback(async () => {
        if (!plan) {
            setProbedModels([]);
            return;
        }
        setProbeLoading(true);
        setProbeError(null);
        setProbeNotice(null);
        try {
            const catalog = await codingPlanApi.models(plan.id);
            const merged = Array.from(
                new Set([plan.model, ...(catalog.models ?? [])].map((m) => m.trim()).filter(Boolean)),
            );
            setProbedModels(merged);
        } catch (e) {
            // 探测失败仍保留套餐配置的默认模型，用户可以先试；
            // 有默认模型时用弱提示，不把「厂商没有 /models」渲染成红色错误。
            if (plan.model) {
                setProbeNotice("该套餐未返回模型列表，使用套餐默认模型");
                setProbedModels([plan.model]);
            } else {
                setProbeError(e instanceof Error ? e.message : "模型列表加载失败");
                setProbedModels([]);
            }
        } finally {
            setProbeLoading(false);
        }
    }, [plan]);

    const ensureCodingModels = useCallback(() => {
        if (probedModels !== null || probeLoading) return;
        void loadCodingModels();
    }, [probedModels, probeLoading, loadCodingModels]);

    const toggle = () => {
        if (disabled || loading) return;
        const next = !open;
        setOpen(next);
        if (next) {
            setTab(codingPlanValue ? "coding" : "system");
            if (codingPlanValue) ensureCodingModels();
        }
    };

    const selectTab = (next: Tab) => {
        setTab(next);
        if (next === "coding") ensureCodingModels();
    };

    const selectedSystem = models.find((m) => m.id === value);
    const activeTab: Tab = forbidden ? "system" : tab;
    // is_default 套餐的默认模型：触发器后缀与弹层徽标都以它为准。
    const isDefaultPlanModel =
        !!codingPlanValue && !!defaultPlan?.model && codingPlanValue === defaultPlan.model;
    const planModelLabel = codingPlanValue
        ? isDefaultPlanModel
            ? `${codingPlanValue} · Coding Plan 默认`
            : codingPlanValue
        : selectedSystem?.label ?? "默认模型";
    const codingModels = useMemo(
        () => probedModels ?? (plan?.model ? [plan.model] : []),
        [probedModels, plan],
    );
    const otherCodingModels = plan?.model
        ? codingModels.filter((model) => model !== plan.model)
        : codingModels;

    return (
        <div ref={rootRef} className="relative min-w-0 shrink">
            <button
                type="button"
                onClick={toggle}
                disabled={disabled || loading}
                aria-expanded={open}
                aria-haspopup="true"
                aria-busy={loading}
                aria-label={loading ? "聊天模型加载中" : `选择聊天模型（当前：${planModelLabel}）`}
                title={
                    loading
                        ? "正在读取聊天模型与 Coding Plan 配置"
                        : isDefaultPlanModel
                            ? `Coding Plan 默认模型：${codingPlanValue}`
                            : "选择聊天模型：系统默认模型或 Coding Plan 模型"
                }
                className="flex h-9 w-full min-w-0 max-w-[42vw] items-center gap-1 rounded-md px-2 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-60 sm:h-8 sm:max-w-[220px] sm:text-[11px]"
            >
                {loading ? (
                    <>
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-tertiary" aria-hidden="true" />
                        <span className="truncate text-tertiary">模型加载中…</span>
                    </>
                ) : (
                    <>
                        {codingPlanValue && (
                            <Boxes className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                        )}
                        <span className="hidden shrink-0 sm:inline">
                            {codingPlanValue ? "套餐" : "模型"}
                        </span>
                        <span className="truncate">{planModelLabel}</span>
                        <ChevronDown
                            className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                            aria-hidden="true"
                        />
                    </>
                )}
            </button>

            {open && (
                <div
                    role="group"
                    aria-label="聊天模型选择"
                    className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
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
                                        {plan ? `${plan.label} · ${plan.provider}` : "未配置"}
                                    </span>
                                </div>

                                {plan && (
                                    <button
                                        type="button"
                                        disabled={!plan.model}
                                        aria-pressed={codingPlanValue === plan.model}
                                        onClick={() => {
                                            if (!plan.model) return;
                                            onChange({ kind: "coding-plan", model: plan.model });
                                            setOpen(false);
                                        }}
                                        className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-border-subtle/60 ${
                                            codingPlanValue === plan.model ? "bg-accent-soft/60" : ""
                                        }`}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-1.5">
                                                {plan.is_default ? (
                                                    <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                                        Coding Plan 默认模型
                                                    </span>
                                                ) : (
                                                    <span className="shrink-0 rounded-sm bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                                        套餐默认模型
                                                    </span>
                                                )}
                                            </span>
                                            <span className="mt-0.5 block truncate font-mono text-[11px] text-foreground">
                                                {plan.model || "（套餐未配置模型）"}
                                            </span>
                                            <span className="mt-0.5 block text-[10px] leading-relaxed text-tertiary">
                                                {plan.label} · {plan.provider}
                                            </span>
                                        </span>
                                        {codingPlanValue === plan.model && (
                                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                        )}
                                    </button>
                                )}

                                {probeLoading && (
                                    <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-tertiary">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                        正在读取套餐模型…
                                    </div>
                                )}

                                {!probeLoading && probeError && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-danger">
                                        {probeError}
                                        <button
                                            type="button"
                                            onClick={() => void loadCodingModels()}
                                            className="ml-1 font-medium underline underline-offset-2"
                                        >
                                            重试
                                        </button>
                                    </div>
                                )}

                                {!probeLoading && probeNotice && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                                        {probeNotice}
                                    </div>
                                )}

                                {!probeLoading && plan && otherCodingModels.length > 0 && (
                                    <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium text-tertiary">
                                        其他套餐模型
                                    </div>
                                )}

                                {!probeLoading &&
                                    otherCodingModels.map((model) => {
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

                                {!probeLoading && !plan && (
                                    <div className="px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                                        未检测到可用 Coding Plan
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {activeTab === "coding" && !forbidden && (
                        <div className="border-t border-border-subtle px-3 py-2 text-[11px] leading-relaxed text-tertiary">
                            {plan?.is_default
                                ? "聊天默认使用该套餐模型；套餐不可用时自动回退平台模型。"
                                : "选择套餐模型会消耗套餐额度；未设为默认套餐时聊天默认使用平台模型。"}
                        </div>
                    )}

                    {onReasoningEffortChange && (
                        <div className="border-t border-border-subtle px-3 pb-2 pt-2.5">
                            <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-tertiary">
                                    推理强度
                                </span>
                                <span className="text-[10px] font-medium tracking-wide text-secondary">
                                    {reasoningEffortLabel(reasoningEffort)} · {Math.round(reasoningEffort)}
                                </span>
                            </div>
                            <EffortSlider
                                value={reasoningEffort}
                                onChange={onReasoningEffortChange}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
