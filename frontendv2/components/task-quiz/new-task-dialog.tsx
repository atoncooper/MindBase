"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, CalendarClock } from "lucide-react";
import { taskQuizApi } from "@/lib/api";
import { cn } from "@/lib/utils";

interface NewTaskDialogProps {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
}

const DIFFICULTIES = [
    { v: "easy", label: "简单", desc: "基础概念" },
    { v: "medium", label: "中等", desc: "常规应用" },
    { v: "hard", label: "压轴", desc: "综合难题" },
] as const;

/**
 * New scheduled-quiz-task dialog. Apple-style centered sheet. The form state
 * lives in <DialogBody>, which only mounts when `open` is true (inside
 * AnimatePresence) - so it initializes fresh each time the dialog opens, with
 * no reset effect needed. datetime-local is local time -> UTC ISO8601 on
 * submit (the backend stores trigger_time as UTC aware).
 */
export function NewTaskDialog({ open, onClose, onCreated }: NewTaskDialogProps) {
    // Escape to close (disabled while submitting).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (typeof document === "undefined") return null;

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                >
                    <div
                        className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.24, ease: [0.28, 0.11, 0.32, 1] }}
                        className="relative flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]"
                        role="dialog"
                        aria-modal="true"
                        aria-label="新建定时出题"
                    >
                        <DialogBody onClose={onClose} onCreated={onCreated} />
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}

/* ─── Form body (mounts fresh each time the dialog opens) ─── */

function DialogBody({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: () => void;
}) {
    const [prompt, setPrompt] = useState("");
    const [difficulty, setDifficulty] = useState<string>("medium");
    const [questionCount, setQuestionCount] = useState(1);
    const [triggerTime, setTriggerTime] = useState("");
    const [ccEmails, setCcEmails] = useState("");
    const [incomplete, setIncomplete] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Floor for the datetime-local input = now (local). Computed once on mount.
    const [nowLocal] = useState(() =>
        new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16),
    );

    const disabled = submitting || !prompt.trim() || !triggerTime;

    async function submit() {
        if (disabled) return;
        setSubmitting(true);
        setError(null);
        try {
            const utc = new Date(triggerTime).toISOString();
            const ccs = ccEmails
                .split(/[,，\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            await taskQuizApi.register({
                prompt: prompt.trim(),
                triggerTime: utc,
                ccEmails: ccs,
                incompleteMessage: incomplete.trim() || null,
                difficulty,
                questionCount,
            });
            onCreated();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        }
        setSubmitting(false);
    }

    return (
        <>
            {/* Header */}
            <div className="flex items-center gap-2.5 border-b border-border-subtle px-6 py-4">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
                    <CalendarClock className="h-4 w-4" />
                </div>
                <h2 className="text-[16px] font-semibold tracking-tight text-foreground">
                    新建定时出题
                </h2>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
                <p className="mb-5 text-[13px] leading-relaxed text-secondary">
                    设置出题方向和触发时间，到点系统自动出题并发邮件提醒（请先在个人中心填好邮箱）。
                </p>

                {error && (
                    <div className="mb-4 rounded-lg bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
                        {error}
                    </div>
                )}

                {/* Prompt */}
                <div className="mb-4">
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        出题方向 <span className="text-danger">*</span>
                    </label>
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        className="field resize-none"
                        rows={2}
                        placeholder="如：数学1填空题、英语阅读、政治马原、408数据结构等"
                        maxLength={500}
                    />
                </div>

                {/* Difficulty segmented control */}
                <div className="mb-4">
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        难度（考研难度）<span className="text-danger">*</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {DIFFICULTIES.map((o) => {
                            const active = difficulty === o.v;
                            return (
                                <button
                                    key={o.v}
                                    type="button"
                                    onClick={() => setDifficulty(o.v)}
                                    className={cn(
                                        "rounded-lg border px-2 py-2 text-center transition-all",
                                        active
                                            ? "border-accent bg-accent-soft text-accent"
                                            : "border-border bg-surface text-foreground hover:border-tertiary",
                                    )}
                                >
                                    <div className="text-[13px] font-medium leading-tight">
                                        {o.label}
                                    </div>
                                    <div className="mt-0.5 text-[11px] leading-tight text-tertiary">
                                        {o.desc}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Question count */}
                <div className="mb-4">
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        题目数量
                        <span className="ml-1.5 font-normal text-tertiary">
                            （一次生成多道题，最多 5 道）
                        </span>
                    </label>
                    <div className="grid grid-cols-5 gap-2">
                        {[1, 2, 3, 4, 5].map((c) => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setQuestionCount(c)}
                                className={cn(
                                    "h-10 rounded-lg border text-[13px] font-medium transition-all",
                                    questionCount === c
                                        ? "border-accent bg-accent-soft text-accent"
                                        : "border-border bg-surface text-foreground hover:border-tertiary",
                                )}
                            >
                                {c}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Trigger time */}
                <div className="mb-4">
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        触发时间 <span className="text-danger">*</span>
                        <span className="ml-1.5 font-normal text-tertiary">
                            （本地时间，到点自动出题）
                        </span>
                    </label>
                    <input
                        type="datetime-local"
                        value={triggerTime}
                        onChange={(e) => setTriggerTime(e.target.value)}
                        className="field"
                        min={nowLocal}
                    />
                </div>

                {/* CC emails */}
                <div className="mb-4">
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        抄送人邮箱
                        <span className="ml-1.5 font-normal text-tertiary">
                            （逗号分隔，可选）
                        </span>
                    </label>
                    <input
                        value={ccEmails}
                        onChange={(e) => setCcEmails(e.target.value)}
                        className="field"
                        placeholder="a@x.com, b@y.com"
                    />
                </div>

                {/* Incomplete message */}
                <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-secondary">
                        未完成语录
                        <span className="ml-1.5 font-normal text-tertiary">
                            （可选，留空用默认模板）
                        </span>
                    </label>
                    <textarea
                        value={incomplete}
                        onChange={(e) => setIncomplete(e.target.value)}
                        className="field resize-none"
                        rows={2}
                        placeholder="超时未答题时的提醒语"
                    />
                </div>
            </div>

            {/* Footer buttons */}
            <div className="flex border-t border-border-subtle">
                <button
                    type="button"
                    onClick={onClose}
                    disabled={submitting}
                    className="flex-1 h-12 text-[14px] font-medium text-secondary transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
                >
                    取消
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={disabled}
                    className="flex flex-1 items-center justify-center gap-1.5 h-12 border-l border-border-subtle text-[14px] font-semibold text-accent transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
                >
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    提交任务
                </button>
            </div>
        </>
    );
}
