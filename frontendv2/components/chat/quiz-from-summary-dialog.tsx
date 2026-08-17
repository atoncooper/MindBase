"use client";

/**
 * QuizFromSummaryDialog - generate a practice set from the chat session's
 * summary (slash command "生成题目").
 *
 * Phases: config → generating (poll) → success / failed. Mirrors the
 * GenerateDialog polling pattern (quizApi.getQuiz every 2s until
 * done/partial/failed), but is a centered modal instead of a full-screen
 * wizard since the only source is the current session's summary.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, AlertCircle, CheckCircle2, FileText } from "lucide-react";
import { quizApi, sessionSummaryApi, type QuizSetData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface QuizFromSummaryDialogProps {
    open: boolean;
    onClose: () => void;
    chatSessionId: string | null;
}

const COUNTS = [5, 10, 15, 20];
const DIFFS = [
    { v: "easy", label: "简单" },
    { v: "medium", label: "中等" },
    { v: "hard", label: "困难" },
];

type Phase = "config" | "generating" | "success" | "failed";

export function QuizFromSummaryDialog({
    open,
    onClose,
    chatSessionId,
}: QuizFromSummaryDialogProps) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && phase !== "generating") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    });

    const router = useRouter();
    const [phase, setPhase] = useState<Phase>("config");
    const [count, setCount] = useState(5);
    const [difficulty, setDifficulty] = useState("medium");
    const [error, setError] = useState<string | null>(null);
    const [pollUuid, setPollUuid] = useState<string | null>(null);
    const [result, setResult] = useState<QuizSetData | null>(null);
    // null = checking, false = none (will auto-generate), doc = reuse
    const [hasSummary, setHasSummary] = useState<boolean | null>(null);

    // Reset + probe summary availability whenever the dialog opens.
    useEffect(() => {
        if (!open || !chatSessionId) return;
        setPhase("config");
        setError(null);
        setPollUuid(null);
        setResult(null);
        setHasSummary(null);
        let cancelled = false;
        (async () => {
            try {
                const doc = await sessionSummaryApi.getLatest(chatSessionId);
                if (!cancelled) setHasSummary(doc !== null);
            } catch {
                if (!cancelled) setHasSummary(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, chatSessionId]);

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
                        setResult(q);
                        setPhase("success");
                        return;
                    }
                    if (q.status === "failed") {
                        setPhase("failed");
                        setError(q.error_message || "题目生成失败，请重试");
                        return;
                    }
                } catch {
                    if (cancelled) return;
                    setPhase("failed");
                    setError("查询生成状态失败，请重试");
                    return;
                }
                await new Promise((r) => setTimeout(r, 2000));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pollUuid]);

    async function startGenerate() {
        if (!chatSessionId) return;
        setPhase("generating");
        setError(null);
        try {
            const res = await quizApi.generateFromSummary({
                chat_session_id: chatSessionId,
                question_count: count,
                difficulty,
            });
            setPollUuid(res.quiz_uuid);
        } catch (e) {
            setPhase("config");
            setError(e instanceof Error ? e.message : "出题请求失败");
        }
    }

    return createPortal(
        <AnimatePresence>
            {open && chatSessionId && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 p-4 backdrop-blur-[2px]"
                    onClick={phase === "generating" ? undefined : onClose}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.97, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 8 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className="w-full max-w-[440px] rounded-3xl border border-border bg-surface p-6 shadow-[0_16px_48px_rgba(0,0,0,0.16)]"
                        onClick={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-label="基于会话总结生成题目"
                    >
                        <div className="flex items-center justify-between">
                            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                                生成题目
                            </h2>
                            {phase !== "generating" && (
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                                    aria-label="关闭"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>

                        {phase === "config" && (
                            <div className="mt-5">
                                {/* Summary availability hint */}
                                <div className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-background px-3.5 py-3">
                                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
                                    <div className="min-w-0 text-[12px] leading-relaxed">
                                        <div className="text-foreground">
                                            {hasSummary === null
                                                ? "正在检查会话总结…"
                                                : hasSummary
                                                  ? "将复用已有的会话总结"
                                                  : "暂无会话总结，生成时将自动创建"}
                                        </div>
                                        <div className="mt-0.5 text-tertiary">
                                            题目基于当前会话的总结内容出题，完成后进入题库作答
                                        </div>
                                    </div>
                                </div>

                                {/* Question count */}
                                <div className="mt-5">
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
                                <div className="mt-5">
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

                                {error && (
                                    <div className="mt-4 flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        {error}
                                    </div>
                                )}

                                <button
                                    type="button"
                                    onClick={startGenerate}
                                    className="btn-pill btn-primary mt-6 h-10 w-full text-[13px]"
                                >
                                    开始生成
                                </button>
                            </div>
                        )}

                        {phase === "generating" && (
                            <div className="flex flex-col items-center gap-4 py-10 text-center">
                                <Loader2 className="h-9 w-9 animate-spin text-foreground" />
                                <div>
                                    <p className="text-[15px] font-medium text-foreground">
                                        正在生成题目…
                                    </p>
                                    <p className="mt-1.5 text-[13px] text-tertiary">
                                        {hasSummary
                                            ? "基于会话总结出题，通常需要 20-60 秒"
                                            : "正在生成会话总结并出题，通常需要 30-90 秒"}
                                    </p>
                                </div>
                                <div className="mt-1 flex items-center gap-4 text-[12px] text-tertiary">
                                    <span>{count} 题</span>
                                    <span className="h-3 w-px bg-border" />
                                    <span>{DIFFS.find((d) => d.v === difficulty)?.label}</span>
                                </div>
                            </div>
                        )}

                        {phase === "success" && result && (
                            <div className="flex flex-col items-center gap-4 py-8 text-center">
                                <CheckCircle2 className="h-10 w-10 text-foreground" />
                                <div>
                                    <p className="text-[15px] font-medium text-foreground">
                                        已生成 {result.question_count} 道题目
                                    </p>
                                    <p className="mt-1 line-clamp-2 text-[13px] text-tertiary">
                                        {result.title}
                                    </p>
                                </div>
                                <div className="mt-2 flex w-full gap-2">
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="btn-pill btn-ghost h-10 flex-1 text-[13px]"
                                    >
                                        稍后再做
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onClose();
                                            router.push(`/quiz?quiz=${result.quiz_uuid}`);
                                        }}
                                        className="btn-pill btn-primary h-10 flex-1 text-[13px]"
                                    >
                                        去答题
                                    </button>
                                </div>
                            </div>
                        )}

                        {phase === "failed" && (
                            <div className="flex flex-col items-center gap-4 py-8 text-center">
                                <AlertCircle className="h-10 w-10 text-danger" />
                                <p className="max-w-[320px] text-[13px] leading-relaxed text-foreground">
                                    {error || "题目生成失败，请重试"}
                                </p>
                                <div className="mt-2 flex w-full gap-2">
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="btn-pill btn-ghost h-10 flex-1 text-[13px]"
                                    >
                                        关闭
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setError(null);
                                            setPhase("config");
                                        }}
                                        className="btn-pill btn-primary h-10 flex-1 text-[13px]"
                                    >
                                        重试
                                    </button>
                                </div>
                            </div>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}
