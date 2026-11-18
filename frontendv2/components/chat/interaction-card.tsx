"use client";

/**
 * InteractionCard - AI→用户结构化交互卡（ask_user 工具 → `interact` SSE 帧）。
 *
 * 三种形态（与 app-ts InteractionPayload 对齐）：
 *   clarify —— 澄清提问，可点选项，选择后自动作为下一条消息发送；
 *   confirm —— 写操作前确认，选项即「确认执行 / 取消」；
 *   form    —— 多字段表单一次收集，提交时把「字段label：值」逐行拼成答案。
 *
 * 回答即发送（round-based，无恢复协议）：answered 后进入只读 settled 态。
 */

import { useState, type ComponentType } from "react";
import { Check, ChevronRight, CircleHelp, ClipboardList, Send, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatInteraction } from "@/lib/chat-stream";

const KIND_META: Record<
    ChatInteraction["kind"],
    { label: string; icon: ComponentType<{ className?: string }> }
> = {
    clarify: { label: "请你选择", icon: CircleHelp },
    confirm: { label: "请确认操作", icon: ShieldCheck },
    form: { label: "补充信息", icon: ClipboardList },
};

const FIELD_TYPE: Record<string, string> = {
    text: "text",
    email: "email",
    datetime: "datetime-local",
    select: "select",
};

export function InteractionCard({
    interaction,
    answered,
    disabled,
    onAnswer,
}: {
    interaction: ChatInteraction;
    answered: boolean;
    disabled?: boolean;
    onAnswer: (answer: string) => void;
}) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [selected, setSelected] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);

    const isForm = interaction.kind === "form";
    const chips = isForm ? [] : interaction.options ?? [];
    const fields = isForm ? interaction.fields ?? [] : [];
    const locked = answered || disabled;
    const meta = KIND_META[interaction.kind];
    const Icon = meta.icon;

    const choose = (value: string) => {
        if (locked) return;
        setSelected(value);
        onAnswer(value);
    };

    const submitForm = () => {
        const missing = fields.filter((f) => f.required && !values[f.name]?.trim());
        if (missing.length > 0) {
            setFormError(`请填写：${missing.map((f) => f.label).join("、")}`);
            return;
        }
        const lines = fields
            .filter((f) => values[f.name]?.trim())
            .map((f) => `${f.label}：${values[f.name]!.trim()}`);
        if (lines.length === 0) {
            setFormError("请至少填写一项");
            return;
        }
        setFormError(null);
        onAnswer(lines.join("\n"));
    };

    return (
        <div
            className={cn(
                "mt-3 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-opacity",
                locked && "opacity-80",
            )}
            role="group"
            aria-label={meta.label}
        >
            <div className="flex items-center gap-2 border-b border-border-subtle bg-border-subtle/30 px-3.5 py-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <Icon className="h-3 w-3" />
                </span>
                <span className="text-[11px] font-medium text-secondary">{meta.label}</span>
                {answered ? (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-success">
                        <Check className="h-3 w-3" />
                        已发送
                    </span>
                ) : (
                    <span className="ml-auto text-[10px] text-tertiary">
                        {isForm ? "填写后提交" : "选择后自动发送"}
                    </span>
                )}
            </div>

            <div className="px-3.5 py-3">
                <p className="text-[14px] font-semibold leading-relaxed text-foreground">
                    {interaction.question}
                </p>
                {interaction.context && (
                    <p className="mt-1 text-[12px] leading-relaxed text-secondary">{interaction.context}</p>
                )}

                {chips.length > 0 && (
                    <div className="mt-2.5 grid gap-1.5">
                        {chips.map((option, index) => {
                            const active = selected === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    disabled={locked}
                                    aria-pressed={active}
                                    onClick={() => choose(option.value)}
                                    className={cn(
                                        "group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                                        active
                                            ? "border-accent bg-accent-soft"
                                            : "border-border-subtle bg-background/40 hover:border-accent/50 hover:bg-accent-soft/40",
                                        locked ? "cursor-default" : "cursor-pointer",
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                                            active
                                                ? "border-accent bg-accent text-white"
                                                : "border-border text-tertiary group-hover:border-accent/60 group-hover:text-accent",
                                        )}
                                    >
                                        {active ? <Check className="h-3 w-3" /> : index + 1}
                                    </span>
                                    <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
                                        {option.label}
                                    </span>
                                    {!locked && (
                                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {fields.length > 0 && (
                    <div className="mt-2.5 space-y-2.5">
                        {fields.map((field) => (
                            <label key={field.name} className="block">
                                <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-secondary">
                                    {field.label}
                                    {field.required && <span className="text-danger">*</span>}
                                </span>
                                {FIELD_TYPE[field.type ?? "text"] === "select" ? (
                                    <select
                                        value={values[field.name] ?? ""}
                                        disabled={locked}
                                        onChange={(e) =>
                                            setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                                        }
                                        className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none transition-colors focus:border-accent disabled:opacity-70"
                                    >
                                        <option value="">请选择…</option>
                                        {(field.options ?? []).map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type={FIELD_TYPE[field.type ?? "text"]}
                                        value={values[field.name] ?? ""}
                                        disabled={locked}
                                        onChange={(e) =>
                                            setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                                        }
                                        className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-foreground outline-none transition-colors focus:border-accent disabled:opacity-70"
                                    />
                                )}
                            </label>
                        ))}
                        {formError && <p className="text-[11px] text-danger">{formError}</p>}
                        {!answered && (
                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    disabled={locked}
                                    onClick={submitForm}
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                                >
                                    <Send className="h-3 w-3" aria-hidden="true" />
                                    提交回答
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
