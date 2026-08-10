"use client";

/**
 * QuizResult - post-submission review.
 *
 * Flat monochrome layout (Apple-style): a big score header divided from the
 * per-question review by a hairline. Each question is a self-contained block
 * (number + verdict icon, question, my answer, correct answer, grading note)
 * separated by spacing - no colored boxes. Correctness is conveyed by the
 * check/cross icon shape and weight, not by color.
 */
import { motion } from "framer-motion";
import { ArrowLeft, RefreshCw, Check, X } from "lucide-react";
import type { QuizSetData, QuizSubmissionResult } from "@/lib/api";
import { Markdown } from "@/components/markdown";

interface QuizResultProps {
    quiz: QuizSetData;
    result: QuizSubmissionResult;
    /** user's submitted answers, keyed by question_uuid (captured at submit) */
    answers: Record<string, string | string[]>;
    onBack: () => void;
    onRetry: () => void;
}

type Answer = string | string[];

function joinAnswer(a: Answer | undefined): string {
    if (!a) return "（未作答）";
    return Array.isArray(a) ? a.join("、") : a;
}

export function QuizResult({
    quiz,
    result,
    answers,
    onBack,
    onRetry,
}: QuizResultProps) {
    const pct =
        result.total_count > 0
            ? Math.round((result.correct_count / result.total_count) * 100)
            : 0;
    const passed = result.passed;

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.28, 0.11, 0.32, 1] }}
            className="mx-auto max-w-[760px] px-5 py-8 md:px-8"
        >
            <button
                type="button"
                onClick={onBack}
                className="mb-6 flex items-center gap-1.5 text-[13px] text-secondary transition-colors hover:text-foreground"
            >
                <ArrowLeft className="h-4 w-4" />
                返回列表
            </button>

            {/* Score header - flat, divided by hairline */}
            <div className="border-b border-border-subtle pb-6">
                <p className="text-[12px] font-medium uppercase tracking-wider text-tertiary">
                    {quiz.title || "练习结果"}
                </p>
                <div className="mt-3 flex items-baseline gap-3">
                    <span className="text-[56px] font-semibold leading-none tracking-tight text-foreground">
                        {result.score ?? pct}
                    </span>
                    <span className="text-[15px] text-secondary">
                        {result.correct_count}/{result.total_count} 题正确
                    </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-secondary">
                    <span className="flex items-center gap-1.5">
                        {passed ? (
                            <Check className="h-4 w-4 text-foreground" />
                        ) : (
                            <X className="h-4 w-4 text-foreground" />
                        )}
                        {passed ? "已通过" : "未通过"}
                    </span>
                    <span>·</span>
                    <span>难度 {quiz.difficulty}</span>
                </div>
            </div>

            {/* Per-question review */}
            <div className="mt-6 space-y-7">
                {quiz.questions.map((q, i) => {
                    const r = result.results.find(
                        (x) => x.question_uuid === q.question_uuid,
                    );
                    const correct = r?.is_correct === true;
                    return (
                        <div key={q.question_uuid}>
                            {/* Verdict row */}
                            <div className="flex items-center gap-2.5">
                                {correct ? (
                                    <Check className="h-[18px] w-[18px] text-foreground" />
                                ) : (
                                    <X className="h-[18px] w-[18px] text-foreground" />
                                )}
                                <span className="text-[13px] font-medium text-foreground">
                                    第 {i + 1} 题
                                </span>
                                <span className="text-[11px] text-tertiary">
                                    {q.question_type}
                                </span>
                            </div>

                            {/* Question */}
                            <div className="mt-2.5 md-body text-[15px] leading-relaxed text-foreground">
                                <Markdown>{q.question_text}</Markdown>
                            </div>

                            {/* My answer */}
                            <div className="mt-3">
                                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                    我的答案
                                </div>
                                <div className="md-body text-[14px] leading-relaxed text-foreground">
                                    <Markdown>
                                        {joinAnswer(answers[q.question_uuid])}
                                    </Markdown>
                                </div>
                            </div>

                            {/* Correct answer (always show for review) */}
                            {r?.correct_answer && (
                                <div className="mt-3">
                                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        正确答案
                                    </div>
                                    <div className="md-body text-[14px] leading-relaxed text-foreground">
                                        <Markdown>
                                            {joinAnswer(r.correct_answer)}
                                        </Markdown>
                                    </div>
                                </div>
                            )}

                            {/* Grading note / explanation */}
                            {r?.grading_note && (
                                <div className="mt-3">
                                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                                        解析
                                    </div>
                                    <div className="md-body text-[14px] leading-relaxed text-secondary">
                                        <Markdown>{r.grading_note}</Markdown>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Footer actions */}
            <div className="mt-8 flex items-center gap-3">
                <button
                    type="button"
                    onClick={onRetry}
                    className="btn-pill btn-ghost h-10 px-5 text-[14px]"
                >
                    <RefreshCw className="h-4 w-4" />
                    再练一次
                </button>
                <button
                    type="button"
                    onClick={onBack}
                    className="btn-pill btn-primary h-10 px-6 text-[14px]"
                >
                    返回列表
                </button>
            </div>
        </motion.div>
    );
}
