"use client";

/**
 * TaskQuizDetail - right pane of the task-quiz view.
 *
 * Renders one task by status:
 *  - pending:   scheduled card (waiting for trigger time)
 *  - sent:      quiz + answer form (single/multiple choice or fill-in) with a
 *               live countdown to the deadline
 *  - completed: quiz + my answer + correct answer + correctness badge
 *  - overdue:   quiz + timeout banner (+ my answer if submitted just-in-time)
 *  - failed:    failure card
 *
 * Answer submission sends a plain string (choice text joined by ", " for
 * multiple, typed text for fill-in). The backend judges isCorrect; we do not
 * reveal the correct answer until the user has submitted.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
    ArrowLeft,
    CalendarClock,
    Clock,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
    Mail,
    Hourglass,
    Sparkles,
} from "lucide-react";
import {
    taskQuizApi,
    type TaskQuizDetail as TaskQuizDetailData,
    type TaskQuizStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";

interface TaskQuizDetailProps {
    detail: TaskQuizDetailData | null;
    loading: boolean;
    onAnswered: () => void;
    onBack: () => void;
}

const STATUS_BADGE: Record<TaskQuizStatus, { label: string; cls: string }> = {
    pending: { label: "待触发", cls: "bg-border-subtle text-secondary" },
    sent: { label: "待答题", cls: "bg-warning/10 text-warning" },
    completed: { label: "已完成", cls: "bg-success/10 text-success" },
    overdue: { label: "已超时", cls: "bg-tertiary/20 text-secondary" },
    failed: { label: "失败", cls: "bg-danger/10 text-danger" },
};

function formatDateTime(iso?: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(
        d.getHours(),
    ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatCountdown(ms: number): string {
    if (ms <= 0) return "00:00";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TaskQuizDetail({
    detail,
    loading,
    onAnswered,
    onBack,
}: TaskQuizDetailProps) {
    if (loading && !detail) return <DetailSkeleton />;
    if (!detail) return <EmptyDetail />;
    return (
        <DetailBody detail={detail} onAnswered={onAnswered} onBack={onBack} />
    );
}

/* ─── Empty / loading ─── */

function EmptyDetail() {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-border-subtle">
                <CalendarClock className="h-6 w-6 text-tertiary" />
            </div>
            <p className="text-[14px] font-medium text-foreground/80">选择左侧任务查看详情</p>
            <p className="text-[12px] text-tertiary">或点击 + 新建一个定时出题任务</p>
        </div>
    );
}

function DetailSkeleton() {
    return (
        <div className="flex h-full flex-col">
            <div className="border-b border-border-subtle px-5 py-4 md:px-8">
                <div className="h-4 w-20 animate-pulse rounded bg-border-subtle" />
                <div className="mt-3 h-5 w-2/3 animate-pulse rounded bg-border-subtle" />
            </div>
            <div className="flex-1 px-5 py-6 md:px-8">
                <div className="mx-auto max-w-[680px] space-y-3">
                    <div className="h-32 animate-pulse rounded-2xl bg-border-subtle" />
                    <div className="h-10 w-40 animate-pulse rounded-full bg-border-subtle" />
                </div>
            </div>
        </div>
    );
}

/* ─── Body ─── */

function DetailBody({
    detail,
    onAnswered,
    onBack,
}: {
    detail: TaskQuizDetailData;
    onAnswered: () => void;
    onBack: () => void;
}) {
    const badge = STATUS_BADGE[detail.status];
    const quiz = detail.quiz;

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-start gap-3 border-b border-border-subtle px-5 py-4 md:px-8">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="返回列表"
                    className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span
                            className={cn(
                                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                badge.cls,
                            )}
                        >
                            {badge.label}
                        </span>
                        <span className="text-[11px] text-tertiary">
                            {formatDateTime(detail.triggerTime)} 触发
                        </span>
                    </div>
                    <h2 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-tight text-foreground">
                        {detail.prompt}
                    </h2>
                    {detail.ccEmails && detail.ccEmails.length > 0 && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-tertiary">
                            <Mail className="h-3 w-3" />
                            抄送 {detail.ccEmails.join("，")}
                        </div>
                    )}
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-6 md:px-8">
                <div className="mx-auto max-w-[680px]">
                    {detail.status === "pending" && <PendingState detail={detail} />}
                    {detail.status === "failed" && <FailedState />}
                    {detail.status === "sent" && !quiz && <GeneratingState />}
                    {quiz &&
                        (detail.status === "sent" ||
                            detail.status === "completed" ||
                            detail.status === "overdue") && (
                            <QuizCard detail={detail} onAnswered={onAnswered} />
                        )}
                </div>
            </div>
        </div>
    );
}

/* ─── Status states ─── */

function PendingState({ detail }: { detail: TaskQuizDetailData }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.28, 0.11, 0.32, 1] }}
            className="rounded-2xl border border-border bg-surface p-6 text-center"
        >
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                <CalendarClock className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">
                任务已排期
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-secondary">
                将在 {formatDateTime(detail.triggerTime)} 自动出题，
                <br />
                届时题目会发送至你的邮箱。
            </p>
        </motion.div>
    );
}

function GeneratingState() {
    return (
        <div className="rounded-2xl border border-border bg-surface p-6 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">
                正在生成题目…
            </h3>
            <p className="mt-1.5 text-[13px] text-secondary">
                已到触发时间，系统正在出题，请稍候。
            </p>
        </div>
    );
}

function FailedState() {
    return (
        <div className="rounded-2xl border border-border bg-surface p-6 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-danger/10 text-danger">
                <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">
                出题失败
            </h3>
            <p className="mt-1.5 text-[13px] text-secondary">
                题目生成失败，请稍后重试或新建任务。
            </p>
        </div>
    );
}

/* ─── Quiz card + answer form ─── */

function QuizCard({
    detail,
    onAnswered,
}: {
    detail: TaskQuizDetailData;
    onAnswered: () => void;
}) {
    const quiz = detail.quiz!;
    const answered = detail.answer != null;
    const isChoice = !!quiz.options && quiz.options.length > 0;
    const isMultiple = quiz.questionType.toLowerCase().includes("multiple");

    const [selectedOption, setSelectedOption] = useState<string | null>(null);
    const [selectedOptions, setSelectedOptions] = useState<Set<string>>(
        new Set(),
    );
    const [textAnswer, setTextAnswer] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Live countdown to deadline (only while unanswered and a deadline exists).
    const [remaining, setRemaining] = useState<number | null>(null);
    useEffect(() => {
        if (answered || !detail.deadline) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRemaining(null);
            return;
        }
        const update = () => {
            const ms = new Date(detail.deadline!).getTime() - Date.now();
            setRemaining(ms > 0 ? ms : 0);
        };
        update();
        const t = setInterval(update, 1000);
        return () => clearInterval(t);
    }, [detail.deadline, answered]);

    function toggleOption(opt: string) {
        setSelectedOptions((prev) => {
            const next = new Set(prev);
            if (next.has(opt)) next.delete(opt);
            else next.add(opt);
            return next;
        });
    }

    async function submit() {
        let answerStr = "";
        if (isChoice) {
            answerStr = isMultiple
                ? Array.from(selectedOptions).join(", ")
                : selectedOption ?? "";
        } else {
            answerStr = textAnswer.trim();
        }
        if (!answerStr) return;
        setSubmitting(true);
        setError(null);
        try {
            await taskQuizApi.submitAnswer(detail.taskId, answerStr);
            onAnswered();
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        }
        setSubmitting(false);
    }

    const canSubmit = isChoice
        ? isMultiple
            ? selectedOptions.size > 0
            : selectedOption != null
        : textAnswer.trim().length > 0;

    const inputLocked = submitting || detail.status === "overdue";

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.28, 0.11, 0.32, 1] }}
        >
            {/* Countdown / overdue banner — flat monochrome line, no color box */}
            {!answered && remaining != null && (
                <div
                    className={cn(
                        "mb-4 flex items-center gap-2 text-[13px] font-medium",
                        remaining < 60000 ? "text-foreground" : "text-secondary",
                    )}
                >
                    <Clock className="h-4 w-4" />
                    {remaining > 0
                        ? `剩余答题时间 ${formatCountdown(remaining)}`
                        : "答题已超时"}
                </div>
            )}
            {!answered && detail.status === "overdue" && (
                <div className="mb-4 flex items-center gap-2 text-[13px] text-secondary">
                    <Hourglass className="h-4 w-4" />
                    答题截止时间已过
                </div>
            )}

            {/* Question card */}
            <div className="rounded-2xl border border-border bg-surface p-5 md:p-6">
                <div className="mb-3 flex items-center gap-2">
                    <span className="rounded-md bg-border-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
                        {quiz.difficulty}
                    </span>
                    <span className="text-[11px] text-tertiary">
                        {quiz.questionType}
                    </span>
                    {isMultiple && (
                        <span className="text-[11px] text-tertiary">· 多选</span>
                    )}
                </div>
                <div className="md-body text-[15px] leading-relaxed text-foreground">
                    <Markdown>{quiz.question}</Markdown>
                </div>

                {/* Choice options (input mode) */}
                {isChoice && !answered && (
                    <div className="mt-4 space-y-2">
                        {quiz.options!.map((opt, i) => {
                            const active = isMultiple
                                ? selectedOptions.has(opt)
                                : selectedOption === opt;
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    disabled={inputLocked}
                                    onClick={() =>
                                        isMultiple
                                            ? toggleOption(opt)
                                            : setSelectedOption(opt)
                                    }
                                    className={cn(
                                        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[14px] transition-all",
                                        active
                                            ? "border-foreground bg-surface text-foreground"
                                            : "border-border bg-surface text-foreground/90 hover:border-tertiary",
                                        inputLocked && "opacity-60",
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "grid h-5 w-5 shrink-0 place-items-center border text-[11px] font-medium",
                                            isMultiple ? "rounded-[6px]" : "rounded-full",
                                            active
                                                ? "border-foreground bg-foreground text-surface"
                                                : "border-tertiary text-tertiary",
                                        )}
                                    >
                                        {active && <CheckCircle2 className="h-3.5 w-3.5" />}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <Markdown inline>{opt}</Markdown>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Fill-in input (input mode) */}
                {!isChoice && !answered && (
                    <textarea
                        value={textAnswer}
                        onChange={(e) => setTextAnswer(e.target.value)}
                        disabled={inputLocked}
                        className="field mt-4 resize-none"
                        rows={4}
                        placeholder="输入你的答案…"
                    />
                )}
            </div>

            {/* Result (answered) */}
            {answered && detail.answer && (
                <ResultCard
                    answer={detail.answer.answer}
                    isCorrect={detail.answer.isCorrect}
                    correctAnswer={quiz.answer}
                    submittedAt={detail.answer.submittedAt}
                />
            )}

            {/* Submit */}
            {!answered && detail.status === "sent" && (
                <div className="mt-4">
                    {error && (
                        <div className="mb-3 flex items-center gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3.5 py-2.5 text-[13px] text-foreground">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            {error}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canSubmit || submitting}
                        className="btn-pill btn-primary h-10 px-6 text-[14px]"
                    >
                        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                        提交答案
                    </button>
                </div>
            )}
        </motion.div>
    );
}

/* ─── Result card ─── */

function ResultCard({
    answer,
    isCorrect,
    correctAnswer,
    submittedAt,
}: {
    answer: string;
    isCorrect: boolean;
    correctAnswer: string;
    submittedAt: string;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.28, 0.11, 0.32, 1] }}
            className="mt-5"
        >
            {/* Verdict - flat monochrome row, no color box */}
            <div className="flex items-center gap-2.5 border-b border-border-subtle pb-3">
                {isCorrect ? (
                    <CheckCircle2 className="h-5 w-5 text-foreground" />
                ) : (
                    <XCircle className="h-5 w-5 text-foreground" />
                )}
                <span className="text-[15px] font-semibold tracking-tight text-foreground">
                    {isCorrect ? "回答正确" : "回答错误"}
                </span>
                <span className="ml-auto text-[11px] text-tertiary">
                    {formatDateTime(submittedAt)} 提交
                </span>
            </div>

            {/* My answer */}
            <div className="mt-4">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                    我的答案
                </div>
                <div className="md-body text-[14px] leading-relaxed text-foreground">
                    <Markdown>{answer || "（空）"}</Markdown>
                </div>
            </div>

            {/* Correct answer */}
            {!isCorrect && (
                <div className="mt-4">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                        <Sparkles className="h-3 w-3" />
                        正确答案
                    </div>
                    <div className="md-body text-[14px] leading-relaxed text-foreground">
                        <Markdown>{correctAnswer}</Markdown>
                    </div>
                </div>
            )}
        </motion.div>
    );
}
