"use client";

/**
 * QuizTaking - the answer flow.
 *
 * Linear single-column flow: header (back + title + progress), current
 * question (Markdown + LaTeX), option list or textarea, footer nav
 * (prev / next / submit). Monochrome option selection mirrors task-quiz
 * (black border + black filled marker when active). Submit sends the whole
 * quiz at once and hands the result + captured answers up to the orchestrator.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Check } from "lucide-react";
import { quizApi, type QuizSetData, type QuizSubmissionResult } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

interface QuizTakingProps {
    quiz: QuizSetData;
    onBack: () => void;
    onSubmitted: (
        result: QuizSubmissionResult,
        answers: Record<string, string | string[]>,
    ) => void;
}

type AnswerMap = Record<string, string | string[]>;

export function QuizTaking({ quiz, onBack, onSubmitted }: QuizTakingProps) {
    const questions = quiz.questions;
    const total = questions.length;
    const [current, setCurrent] = useState(0);
    const [answers, setAnswers] = useState<AnswerMap>({});
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Lazy init captures the start time once on mount.
    const [startedAt] = useState(() => Date.now());

    const q = questions[current];
    // Defensive: a quiz may have no questions yet (still generating, failed,
    // or data lost). All hooks above already ran, so an early return here is
    // safe under rules-of-hooks.
    if (!q) {
        return (
            <div className="mx-auto flex h-[calc(100dvh-3rem)] max-w-[760px] flex-col items-center justify-center gap-3 px-5 text-center">
                <p className="text-[15px] font-medium text-foreground">
                    该题卷暂无题目
                </p>
                <p className="text-[13px] text-secondary">
                    题目可能仍在生成或已失败，请稍后重试
                </p>
                <button
                    type="button"
                    onClick={onBack}
                    className="btn-pill btn-primary mt-2 h-9 px-5 text-[13px]"
                >
                    返回列表
                </button>
            </div>
        );
    }
    const isSingle = q.question_type === "single_choice";
    const isMulti = q.question_type === "multi_choice";
    const isChoice = isSingle || isMulti;

    function setSingle(uuid: string, opt: string) {
        setAnswers((prev) => ({ ...prev, [uuid]: opt }));
    }
    function toggleMulti(uuid: string, opt: string) {
        setAnswers((prev) => {
            const prevArr = Array.isArray(prev[uuid]) ? (prev[uuid] as string[]) : [];
            const next = prevArr.includes(opt)
                ? prevArr.filter((x) => x !== opt)
                : [...prevArr, opt];
            return { ...prev, [uuid]: next };
        });
    }
    function setText(uuid: string, text: string) {
        setAnswers((prev) => ({ ...prev, [uuid]: text }));
    }

    async function submit() {
        setSubmitting(true);
        setError(null);
        try {
            const answerItems = questions.map((qq) => ({
                question_uuid: qq.question_uuid,
                answer: answers[qq.question_uuid] ?? "",
            }));
            const timeSpent = Math.round((Date.now() - startedAt) / 1000);
            const result = await quizApi.submit({
                quiz_uuid: quiz.quiz_uuid,
                answers: answerItems,
                time_spent_seconds: timeSpent,
            });
            onSubmitted(result, answers);
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交批改失败");
        }
        setSubmitting(false);
    }

    const progressPct = total > 0 ? ((current + 1) / total) * 100 : 0;
    const myAnswer = answers[q.question_uuid];
    const activeOpts = isMulti && Array.isArray(myAnswer) ? (myAnswer as string[]) : [];

    return (
        <div className="mx-auto flex h-[calc(100dvh-3rem)] max-w-[760px] flex-col px-5 md:px-8">
            {/* Header */}
            <div className="flex items-center gap-3 pt-6">
                <button
                    type="button"
                    onClick={onBack}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    aria-label="返回"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                        {quiz.title || "题目练习"}
                    </p>
                    <p className="text-[12px] text-tertiary">
                        第 {current + 1} / {total} 题 · 难度 {q.difficulty}
                    </p>
                </div>
            </div>

            {/* Progress bar */}
            <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-border-subtle">
                <div
                    className="h-full rounded-full bg-foreground transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                />
            </div>

            {/* Question */}
            <div className="flex-1 overflow-y-auto py-6">
                <motion.div
                    key={current}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, ease: [0.28, 0.11, 0.32, 1] }}
                >
                    <div className="mb-4 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                        {q.question_type}
                    </div>
                    <div className="md-body text-[16px] leading-relaxed text-foreground">
                        <Markdown>{q.question_text}</Markdown>
                    </div>

                    {/* Choice options */}
                    {isChoice && q.options && (
                        <div className="mt-5 space-y-2">
                            {q.options.map((opt, i) => {
                                const active = isSingle
                                    ? myAnswer === opt
                                    : activeOpts.includes(opt);
                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        disabled={submitting}
                                        onClick={() =>
                                            isSingle
                                                ? setSingle(q.question_uuid, opt)
                                                : toggleMulti(q.question_uuid, opt)
                                        }
                                        className={cn(
                                            "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[14px] transition-all",
                                            active
                                                ? "border-foreground bg-surface text-foreground"
                                                : "border-border bg-surface text-foreground/90 hover:border-tertiary",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "grid h-5 w-5 shrink-0 place-items-center border text-[11px] font-medium",
                                                isMulti ? "rounded-[6px]" : "rounded-full",
                                                active
                                                    ? "border-foreground bg-foreground text-surface"
                                                    : "border-tertiary text-transparent",
                                            )}
                                        >
                                            {active && <Check className="h-3.5 w-3.5" />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <Markdown inline>{opt}</Markdown>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Fill-in / essay */}
                    {!isChoice && (
                        <textarea
                            value={(typeof myAnswer === "string" ? myAnswer : "") ?? ""}
                            onChange={(e) => setText(q.question_uuid, e.target.value)}
                            disabled={submitting}
                            className="field mt-5 resize-none"
                            rows={5}
                            placeholder="输入你的答案…"
                        />
                    )}
                </motion.div>
            </div>

            {/* Footer nav */}
            <div className="border-t border-border-subtle py-4">
                {error && (
                    <div className="mb-3 text-[13px] text-foreground">
                        {error}
                    </div>
                )}
                <div className="flex items-center justify-between gap-3">
                    <button
                        type="button"
                        onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                        disabled={current === 0}
                        className="btn-pill btn-ghost h-10 px-4 text-[14px] disabled:opacity-40"
                    >
                        <ChevronLeft className="h-4 w-4" />
                        上一题
                    </button>
                    {current < total - 1 ? (
                        <button
                            type="button"
                            onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
                            className="btn-pill btn-primary h-10 px-5 text-[14px]"
                        >
                            下一题
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={submit}
                            disabled={submitting}
                            className="btn-pill btn-primary h-10 px-6 text-[14px]"
                        >
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            提交批改
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
