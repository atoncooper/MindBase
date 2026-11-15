"use client";

/**
 * ChatModelPicker - 聊天输入栏的模型选择器（Apple 风格紧凑按钮）。
 *
 * 模型目录来自 GET /chat/models（chat-view 挂载时拉取并传入 models）；点击按钮
 * 向上弹出列表（label + description + 选中勾选）。目录为空（加载失败/未启用）
 * 时组件不渲染，聊天仍按服务端默认模型进行（请求不带 model）。
 * 「默认模型」项对应 value=""：不传 model，由后端按基础配置选择。
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ChatModel } from "@/lib/api";

export function ChatModelPicker({
    models,
    value,
    onChange,
    disabled = false,
}: {
    models: ChatModel[];
    /** 选中的模型 id；"" = 默认模型（请求不带 model） */
    value: string;
    onChange: (modelId: string) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const selected = models.find((m) => m.id === value);

    // Esc / 点击外部关闭（与 CodingPlanModelPicker 同一交互语义）。
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

    // 目录不可用时不渲染：不阻塞聊天，服务端回落到默认模型。
    if (models.length === 0) return null;

    const label = selected?.label ?? "默认模型";

    return (
        <div ref={rootRef} className="relative shrink-0">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`选择聊天模型（当前：${label}）`}
                title="选择聊天模型"
                className="flex h-8 max-w-[112px] items-center gap-1 rounded-md px-2 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50 sm:max-w-[180px]"
            >
                <span className="hidden shrink-0 sm:inline">模型</span>
                <span className="truncate">{label}</span>
                <ChevronDown
                    className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                />
            </button>

            {open && (
                <div
                    role="listbox"
                    aria-label="聊天模型"
                    className="absolute bottom-full right-0 z-50 mb-2 w-72 max-w-[86vw] overflow-hidden rounded-md border border-border bg-surface shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
                >
                    <div className="border-b border-border-subtle px-3 py-2">
                        <div className="text-[12px] font-medium text-foreground">选择模型</div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-tertiary">
                            作用于本轮及之后的消息；「默认模型」由服务端按基础配置选择
                        </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <button
                            type="button"
                            role="option"
                            aria-selected={!selected}
                            onClick={() => {
                                onChange("");
                                setOpen(false);
                            }}
                            className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-border-subtle/60 ${
                                !selected ? "bg-accent-soft/60" : ""
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
                            {!selected && (
                                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                            )}
                        </button>
                        {models.map((model) => {
                            const active = model.id === value;
                            return (
                                <button
                                    key={model.id}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    onClick={() => {
                                        onChange(model.id);
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
                                        <Check
                                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                                            aria-hidden="true"
                                        />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
