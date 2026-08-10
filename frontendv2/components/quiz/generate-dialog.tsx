"use client";

/**
 * GenerateDialog - full-screen wizard to configure a new practice set.
 *
 * Three paginated steps fill the viewport:
 *   1. source    - pick favorite folders (knowledge scope)
 *   2. config    - question count / difficulty / title
 *   3. generating- poll until the quiz is ready
 *
 * A stepper at the top tracks progress; nav buttons at the bottom drive
 * back/next. On success the parent receives the ready quiz via onGenerated.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, AlertCircle, Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
    quizApi,
    favoritesV2Api,
    type FavoriteFolderV2,
    type QuizSetData,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface GenerateDialogProps {
    open: boolean;
    onClose: () => void;
    onGenerated: (quiz: QuizSetData) => void;
}

const COUNTS = [5, 10, 15, 20];
const DIFFS = [
    { v: "easy", label: "简单" },
    { v: "medium", label: "中等" },
    { v: "hard", label: "困难" },
];

type Step = "source" | "config" | "generating";
const STEPS: { key: Step; label: string }[] = [
    { key: "source", label: "选择来源" },
    { key: "config", label: "出题配置" },
    { key: "generating", label: "生成题目" },
];

export function GenerateDialog({ open, onClose, onGenerated }: GenerateDialogProps) {
    return (
        <AnimatePresence>
            {open && (
                <DialogShell onClose={onClose}>
                    <DialogBody onClose={onClose} onGenerated={onGenerated} />
                </DialogShell>
            )}
        </AnimatePresence>
    );
}

function DialogShell({
    onClose,
    children,
}: {
    onClose: () => void;
    children: React.ReactNode;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return createPortal(
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] flex flex-col bg-background"
        >
            {children}
        </motion.div>,
        document.body,
    );
}

function Stepper({ current }: { current: number }) {
    return (
        <div className="flex items-center">
            {STEPS.map((s, i) => {
                const done = i < current;
                const active = i === current;
                return (
                    <div
                        key={s.key}
                        className={cn(
                            "flex items-center",
                            i < STEPS.length - 1 && "flex-1",
                        )}
                    >
                        <div className="flex flex-col items-center gap-1.5">
                            <span
                                className={cn(
                                    "grid h-7 w-7 place-items-center rounded-full border text-[12px] font-medium transition-colors",
                                    done && "border-foreground bg-foreground text-surface",
                                    active && "border-foreground bg-surface text-foreground",
                                    !done && !active && "border-border bg-surface text-tertiary",
                                )}
                            >
                                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                            </span>
                            <span
                                className={cn(
                                    "text-[11px] tracking-tight transition-colors",
                                    active
                                        ? "font-medium text-foreground"
                                        : "text-tertiary",
                                )}
                            >
                                {s.label}
                            </span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <div
                                className={cn(
                                    "mx-3 h-px flex-1 transition-colors",
                                    done ? "bg-foreground" : "bg-border",
                                )}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function DialogBody({
    onClose,
    onGenerated,
}: {
    onClose: () => void;
    onGenerated: (quiz: QuizSetData) => void;
}) {
    const [folders, setFolders] = useState<FavoriteFolderV2[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [count, setCount] = useState(10);
    const [difficulty, setDifficulty] = useState("medium");
    const [title, setTitle] = useState("");
    const [loadingFolders, setLoadingFolders] = useState(true);

    const [step, setStep] = useState<Step>("source");
    const [error, setError] = useState<string | null>(null);
    const [pollUuid, setPollUuid] = useState<string | null>(null);

    // Load favorite folders once.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await favoritesV2Api.listFolders();
                if (cancelled) return;
                setFolders(list);
                // Pre-select folders already marked selected on the server.
                setSelected(
                    new Set(
                        list.filter((f) => f.is_selected).map((f) => f.media_id),
                    ),
                );
            } catch {
                // Leave empty; user will see the empty hint.
            } finally {
                if (!cancelled) setLoadingFolders(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Poll quiz status until done/partial/failed.
    useEffect(() => {
        if (!pollUuid) return;
        let cancelled = false;
        (async () => {
            while (!cancelled) {
                try {
                    const q = await quizApi.getQuiz(pollUuid);
                    if (cancelled) return;
                    if (q.status === "done" || q.status === "partial") {
                        onGenerated(q);
                        return;
                    }
                    if (q.status === "failed") {
                        setStep("config");
                        setError(q.error_message || "题目生成失败，请重试");
                        return;
                    }
                } catch {
                    if (cancelled) return;
                    setStep("config");
                    setError("查询生成状态失败，请重试");
                    return;
                }
                await new Promise((r) => setTimeout(r, 2000));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pollUuid, onGenerated]);

    const stepIndex = STEPS.findIndex((s) => s.key === step);

    function toggleFolder(mediaId: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(mediaId)) next.delete(mediaId);
            else next.add(mediaId);
            return next;
        });
    }

    async function startGenerate() {
        setStep("generating");
        setError(null);
        try {
            const res = await quizApi.generate({
                folder_ids: Array.from(selected),
                question_count: count,
                difficulty,
                title: title.trim() || undefined,
            });
            setPollUuid(res.quiz_uuid);
        } catch (e) {
            setStep("config");
            setError(e instanceof Error ? e.message : "出题请求失败");
        }
    }

    const canNextFromSource = selected.size > 0;

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex items-center justify-between px-6 py-4 md:px-10">
                <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                    新建练习
                </h2>
                <button
                    type="button"
                    onClick={onClose}
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    aria-label="关闭"
                >
                    <X className="h-4 w-4" />
                </button>
            </header>

            {/* Stepper */}
            <div className="mx-auto w-full max-w-[680px] px-6 pb-6">
                <Stepper current={stepIndex} />
            </div>

            {/* Content (fills viewport) */}
            <div className="relative flex-1 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                    {step === "source" && (
                        <motion.div
                            key="source"
                            initial={{ opacity: 0, x: 16 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -16 }}
                            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                            className="h-full overflow-y-auto"
                        >
                            <div className="mx-auto max-w-[680px] px-6 pb-8">
                                <p className="text-[13px] text-secondary">
                                    选择作为出题来源的收藏夹，可多选。仅已向量化的内容会被检索。
                                </p>
                                <div className="mt-4 space-y-1.5">
                                    {loadingFolders ? (
                                        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-tertiary">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            加载收藏夹…
                                        </div>
                                    ) : folders.length === 0 ? (
                                        <div className="py-16 text-center text-[13px] text-tertiary">
                                            暂无收藏夹，请先在收藏夹页同步
                                        </div>
                                    ) : (
                                        folders.map((f) => {
                                            const active = selected.has(f.media_id);
                                            return (
                                                <button
                                                    key={f.media_id}
                                                    type="button"
                                                    onClick={() => toggleFolder(f.media_id)}
                                                    className={cn(
                                                        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
                                                        active
                                                            ? "border-foreground bg-surface"
                                                            : "border-border bg-surface hover:border-tertiary",
                                                    )}
                                                >
                                                    <span
                                                        className={cn(
                                                            "grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border transition-colors",
                                                            active
                                                                ? "border-foreground bg-foreground text-surface"
                                                                : "border-tertiary text-transparent",
                                                        )}
                                                    >
                                                        {active && <Check className="h-3.5 w-3.5" />}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">
                                                        {f.title}
                                                    </span>
                                                    <span className="shrink-0 text-[12px] text-tertiary">
                                                        {f.media_count}
                                                    </span>
                                                </button>
                                            );
                                        })
                                    )}
                                </div>

                                {error && (
                                    <div className="mt-4 flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        {error}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}

                    {step === "config" && (
                        <motion.div
                            key="config"
                            initial={{ opacity: 0, x: 16 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -16 }}
                            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                            className="h-full overflow-y-auto"
                        >
                            <div className="mx-auto max-w-[680px] px-6 pb-8">
                                {/* Selected source summary */}
                                <div className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
                                    <div className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        来源 · {selected.size} 个收藏夹
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-[13px] text-foreground">
                                        {folders
                                            .filter((f) => selected.has(f.media_id))
                                            .map((f) => f.title)
                                            .join("、") || "未选择"}
                                    </div>
                                </div>

                                {/* Question count */}
                                <div className="mt-7">
                                    <label className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        题目数量
                                    </label>
                                    <div className="mt-2.5 grid grid-cols-4 gap-2">
                                        {COUNTS.map((c) => (
                                            <button
                                                key={c}
                                                type="button"
                                                onClick={() => setCount(c)}
                                                className={cn(
                                                    "h-11 rounded-xl border text-[14px] font-medium transition-all",
                                                    count === c
                                                        ? "border-foreground bg-foreground text-surface"
                                                        : "border-border bg-surface text-foreground hover:border-tertiary",
                                                )}
                                            >
                                                {c}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Difficulty */}
                                <div className="mt-7">
                                    <label className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        难度
                                    </label>
                                    <div className="mt-2.5 grid grid-cols-3 gap-2">
                                        {DIFFS.map((d) => (
                                            <button
                                                key={d.v}
                                                type="button"
                                                onClick={() => setDifficulty(d.v)}
                                                className={cn(
                                                    "h-11 rounded-xl border text-[14px] font-medium transition-all",
                                                    difficulty === d.v
                                                        ? "border-foreground bg-foreground text-surface"
                                                        : "border-border bg-surface text-foreground hover:border-tertiary",
                                                )}
                                            >
                                                {d.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Title */}
                                <div className="mt-7">
                                    <label className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        标题（可选）
                                    </label>
                                    <input
                                        value={title}
                                        onChange={(e) => setTitle(e.target.value)}
                                        className="field mt-2.5"
                                        placeholder="如：操作系统复习"
                                        maxLength={60}
                                    />
                                </div>

                                {error && (
                                    <div className="mt-5 flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        {error}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}

                    {step === "generating" && (
                        <motion.div
                            key="generating"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.22 }}
                            className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
                        >
                            <Loader2 className="h-9 w-9 animate-spin text-foreground" />
                            <div>
                                <p className="text-[15px] font-medium text-foreground">
                                    正在生成题目…
                                </p>
                                <p className="mt-1.5 text-[13px] text-tertiary">
                                    基于收藏夹知识库检索与出题，通常需要 10-30 秒
                                </p>
                            </div>
                            <div className="mt-2 flex items-center gap-4 text-[12px] text-tertiary">
                                <span>{count} 题</span>
                                <span className="h-3 w-px bg-border" />
                                <span>
                                    {DIFFS.find((d) => d.v === difficulty)?.label}
                                </span>
                                <span className="h-3 w-px bg-border" />
                                <span>{selected.size} 个来源</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Footer nav */}
            <footer className="border-t border-border-subtle">
                <div className="mx-auto flex w-full max-w-[680px] items-center justify-between px-6 py-4">
                    {step === "source" && (
                        <>
                            <button
                                type="button"
                                onClick={onClose}
                                className="btn-pill btn-ghost h-9 px-4 text-[13px]"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                disabled={!canNextFromSource}
                                onClick={() => {
                                    setError(null);
                                    setStep("config");
                                }}
                                className="btn-pill btn-primary h-9 px-5 text-[13px] disabled:pointer-events-none disabled:opacity-40"
                            >
                                下一步
                                <ChevronRight className="ml-1 h-4 w-4" />
                            </button>
                        </>
                    )}

                    {step === "config" && (
                        <>
                            <button
                                type="button"
                                onClick={() => {
                                    setError(null);
                                    setStep("source");
                                }}
                                className="btn-pill btn-ghost h-9 px-4 text-[13px]"
                            >
                                <ChevronLeft className="mr-1 h-4 w-4" />
                                上一步
                            </button>
                            <button
                                type="button"
                                onClick={startGenerate}
                                className="btn-pill btn-primary h-9 px-5 text-[13px]"
                            >
                                开始生成
                            </button>
                        </>
                    )}

                    {step === "generating" && (
                        <>
                            <span className="text-[12px] text-tertiary">
                                生成中，请勿关闭
                            </span>
                            <button
                                type="button"
                                onClick={onClose}
                                className="btn-pill btn-ghost h-9 px-4 text-[13px]"
                            >
                                取消
                            </button>
                        </>
                    )}
                </div>
            </footer>
        </div>
    );
}
