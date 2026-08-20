"use client";

/**
 * TaskQuizDetail - right pane of the task-quiz view.
 *
 * Renders one task by business status (main app /tasks/{id}/detail; pending
 * fallback is synthesized client-side from the list item):
 *  - pending / running: scheduled card (waiting for trigger time)
 *  - generating:        spinner card (quiz being generated)
 *  - awaiting_answer:   quiz + answer form (single/multiple choice or fill-in)
 *                       with a live countdown to the deadline
 *  - completed:         quiz + my answer + correct answer + correctness badge
 *  - overdue:           quiz + timeout banner (+ my answer if submitted just-in-time)
 *  - failed:            failure card
 *
 * Answer submission sends one entry per question (choice text or typed text).
 * The backend judges isCorrect; we do not reveal the correct answer until the
 * user has submitted.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
    CalendarClock,
    Clock,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
    Mail,
    Hourglass,
} from "lucide-react";
import {
    taskQuizApi,
    type TaskQuizAnswerItem,
    type TaskQuizDetail as TaskQuizDetailData,
    type TaskQuizQuestion,
    type TaskQuizStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";

interface TaskQuizDetailProps {
    detail: TaskQuizDetailData | null;
    loading: boolean;
    onAnswered: () => void;
}

const STATUS_BADGE: Record<TaskQuizStatus, { label: string; cls: string }> = {
    pending: { label: "待触发", cls: "bg-border-subtle text-secondary" },
    running: { label: "执行中", cls: "bg-accent-soft text-accent" },
    generating: { label: "出题中", cls: "bg-accent-soft text-accent" },
    awaiting_answer: { label: "待作答", cls: "bg-warning/10 text-warning" },
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

/**
 * Whether an option matches a quiz answer. The LLM may output the answer as
 * the full option text ("马原") or just its letter ("A"); options may carry a
 * letter prefix ("A. 马原"). Tolerate both shapes so reveal-highlighting works.
 */
function matchesAnswer(opt: string, answer: string): boolean {
    const o = opt.trim();
    const a = answer.trim();
    if (!o || !a) return false;
    if (o === a) return true;
    const letter = a.toUpperCase();
    if (/^[A-F]$/.test(letter)) {
        return new RegExp(`^${letter}[.、)）:\\s]`, "i").test(o);
    }
    return false;
}

export function TaskQuizDetail({
    detail,
    loading,
    onAnswered,
}: TaskQuizDetailProps) {
    if (loading && !detail) return <DetailSkeleton />;
    if (!detail) return <EmptyDetail />;
    return <DetailBody detail={detail} onAnswered={onAnswered} />;
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
}: {
    detail: TaskQuizDetailData;
    onAnswered: () => void;
}) {
    const badge = STATUS_BADGE[detail.status];
    const quiz = detail.quiz;

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-start gap-3 border-b border-border-subtle px-5 py-4 md:px-8">
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
                        {detail.triggerTime && (
                            <span className="text-[11px] text-tertiary">
                                {formatDateTime(detail.triggerTime)} 触发
                            </span>
                        )}
                        {detail.deadline && (
                            <span className="text-[11px] text-tertiary">
                                {formatDateTime(detail.deadline)} 答题截止
                            </span>
                        )}
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
                    {(detail.status === "generating" || detail.status === "running") &&
                        !quiz && <GeneratingState />}
                    {quiz &&
                        (detail.status === "awaiting_answer" ||
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
                {detail.triggerTime
                    ? `将在 ${formatDateTime(detail.triggerTime)} 自动出题，`
                    : "到点将自动出题，"}
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

/* ─── Quiz card + answer form (multi-question) ─── */

function QuizCard({
    detail,
    onAnswered,
}: {
    detail: TaskQuizDetailData;
    onAnswered: () => void;
}) {
    const questions = detail.quiz?.questions ?? [];
    const submitted = detail.answers ?? []; // 防御：旧后端可能缺字段
    const answered = submitted.length > 0;

    // 每题一个答案字符串（选择题=选项文本，填空/简答=输入文本），按下标存
    const [answers, setAnswers] = useState<Record<number, string>>({});
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

    function setAnswer(idx: number, val: string) {
        setAnswers((prev) => ({ ...prev, [idx]: val }));
    }

    async function submit() {
        const items = questions.map((_, i) => ({
            question_index: i,
            answer: (answers[i] ?? "").trim(),
        }));
        if (items.some((it) => !it.answer)) return;
        setSubmitting(true);
        setError(null);
        try {
            await taskQuizApi.submitAnswer(detail.taskId, items);
            onAnswered();
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        }
        setSubmitting(false);
    }

    const answeredCount = questions.filter((_, i) =>
        (answers[i] ?? "").trim(),
    ).length;
    const canSubmit =
        questions.length > 0 && answeredCount === questions.length;
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

            {/* Question list */}
            <div className="space-y-5">
                {questions.map((q, i) => {
                    const myAns = answered
                        ? submitted.find((a) => a.questionIndex === i)
                        : undefined;
                    return (
                        <div
                            key={i}
                            className="rounded-2xl border border-border bg-surface p-5 md:p-6"
                        >
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                <span className="rounded-md bg-border-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
                                    第 {i + 1} 题
                                </span>
                                <span className="rounded-md bg-border-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
                                    {q.difficulty}
                                </span>
                                <span className="text-[11px] text-tertiary">
                                    {q.questionType}
                                </span>
                            </div>
                            <div className="md-body text-[15px] leading-relaxed text-foreground">
                                <Markdown>{q.question}</Markdown>
                            </div>

                            {/* Choice options — always visible; interactive before
                                answering, read-only reveal (correct/wrong) after */}
                            {q.options && q.options.length > 0 ? (
                                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                    {q.options.map((opt, oi) => {
                                        const letter = String.fromCharCode(65 + oi);
                                        const isUserPick = answered
                                            ? matchesAnswer(opt, myAns?.answer ?? "")
                                            : answers[i] === opt;
                                        const isCorrectOpt =
                                            answered && matchesAnswer(opt, q.answer);

                                        const optState:
                                            | "idle"
                                            | "selected"
                                            | "correct"
                                            | "wrong" = answered
                                            ? isCorrectOpt
                                                ? "correct"
                                                : isUserPick
                                                  ? "wrong"
                                                  : "idle"
                                            : isUserPick
                                              ? "selected"
                                              : "idle";

                                        return (
                                            <button
                                                key={oi}
                                                type="button"
                                                disabled={inputLocked || answered}
                                                onClick={() => setAnswer(i, opt)}
                                                className={cn(
                                                    "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[14px] transition-all",
                                                    optState === "correct" &&
                                                        "border-success/40 bg-success/10",
                                                    optState === "wrong" &&
                                                        "border-danger/40 bg-danger/10",
                                                    optState === "selected" &&
                                                        "border-foreground bg-surface text-foreground",
                                                    optState === "idle" &&
                                                        (answered
                                                            ? "border-border bg-surface text-foreground/70"
                                                            : "border-border bg-surface text-foreground/90 hover:border-tertiary"),
                                                    inputLocked && "opacity-60",
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "grid h-5 w-5 shrink-0 place-items-center border text-[11px] font-medium",
                                                        "rounded-full",
                                                        optState === "correct" &&
                                                            "border-success bg-success text-surface",
                                                        optState === "wrong" &&
                                                            "border-danger bg-danger text-surface",
                                                        optState === "selected" &&
                                                            "border-foreground bg-foreground text-surface",
                                                        optState === "idle" &&
                                                            (answered
                                                                ? "border-tertiary/50 text-tertiary"
                                                                : "border-tertiary text-tertiary"),
                                                    )}
                                                >
                                                    {letter}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <Markdown inline>{opt}</Markdown>
                                                </span>
                                                {optState === "correct" && (
                                                    <span className="ml-auto shrink-0 text-[11px] font-medium text-success">
                                                        ✓ 正确答案
                                                    </span>
                                                )}
                                                {optState === "wrong" && (
                                                    <span className="ml-auto shrink-0 text-[11px] font-medium text-danger">
                                                        你的答案
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : !answered ? (
                                /* Fill-in / short answer input (input mode) */
                                <textarea
                                    value={answers[i] ?? ""}
                                    onChange={(e) => setAnswer(i, e.target.value)}
                                    disabled={inputLocked}
                                    className="field mt-4 resize-none"
                                    rows={3}
                                    placeholder="输入你的答案…"
                                />
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {/* Result summary (answered) */}
            {answered && <ResultSummary answers={submitted} questions={questions} />}

            {/* Submit */}
            {!answered && detail.status === "awaiting_answer" && (
                <div className="mt-5">
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
                        提交答案 · {answeredCount}/{questions.length}
                    </button>
                </div>
            )}
        </motion.div>
    );
}

/* ─── Result summary (per-question verdicts) ─── */

function ResultSummary({
    answers,
    questions,
}: {
    answers: TaskQuizAnswerItem[];
    questions: TaskQuizQuestion[];
}) {
    const allCorrect = answers.length > 0 && answers.every((a) => a.isCorrect);
    const correctCount = answers.filter((a) => a.isCorrect).length;

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.28, 0.11, 0.32, 1] }}
            className="mt-5"
        >
            {/* Verdict - flat monochrome row, no color box */}
            <div className="flex items-center gap-2.5 border-b border-border-subtle pb-3">
                {allCorrect ? (
                    <CheckCircle2 className="h-5 w-5 text-foreground" />
                ) : (
                    <XCircle className="h-5 w-5 text-foreground" />
                )}
                <span className="text-[15px] font-semibold tracking-tight text-foreground">
                    {allCorrect
                        ? "全部回答正确"
                        : `答对 ${correctCount}/${questions.length}`}
                </span>
                {answers[0] && (
                    <span className="ml-auto text-[11px] text-tertiary">
                        {formatDateTime(answers[0].submittedAt)} 提交
                    </span>
                )}
            </div>

            {/* Per-question my/correct answers */}
            <div className="mt-4 space-y-4">
                {questions.map((q, i) => {
                    const r = answers.find((a) => a.questionIndex === i);
                    if (!r) return null;
                    return (
                        <div key={i} className="rounded-xl border border-border bg-surface p-4">
                            <div className="flex items-center gap-2">
                                {r.isCorrect ? (
                                    <CheckCircle2 className="h-4 w-4 text-success" />
                                ) : (
                                    <XCircle className="h-4 w-4 text-danger" />
                                )}
                                <span className="text-[13px] font-medium tracking-tight text-foreground">
                                    第 {i + 1} 题
                                </span>
                            </div>
                            <div className="mt-2 text-[14px] leading-relaxed">
                                <span className="text-tertiary">我的答案：</span>
                                <span className="text-foreground">
                                    <Markdown inline>{r.answer || "（空）"}</Markdown>
                                </span>
                            </div>
                            {!r.isCorrect && (
                                <div className="mt-1 text-[14px] leading-relaxed">
                                    <span className="text-tertiary">正确答案：</span>
                                    <span className="font-medium text-foreground">
                                        <Markdown inline>{q.answer}</Markdown>
                                    </span>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </motion.div>
    );
}
