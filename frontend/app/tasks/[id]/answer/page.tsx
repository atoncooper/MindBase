'use client';

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getTask, submitAnswer, TaskDetail } from "@/lib/task-quiz-api";
import { MathText } from "@/components/MathText";

const TYPE_LABEL: Record<string, string> = {
    choice: "选择题",
    fill_blank: "填空题",
    short_answer: "简答题",
};

export default function AnswerPage() {
    const params = useParams();
    const router = useRouter();
    const [task, setTask] = useState<TaskDetail | null>(null);
    const [answer, setAnswer] = useState("");
    const [selected, setSelected] = useState<number | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getTask(params.id as string)
            .then(setTask)
            .catch((e) => setError(String(e)));
    }, [params.id]);

    const quiz = task?.quiz ?? null;
    const isChoice = !!(quiz?.options?.length);
    const revealed = !!task?.answer; // already answered -> reveal correct/wrong
    const canSubmit = isChoice ? selected !== null : answer.trim().length > 0;

    async function submit() {
        if (!task || !quiz) return;
        const payload = isChoice
            ? selected !== null
                ? quiz.options![selected]
                : ""
            : answer.trim();
        if (!payload) return;
        setSubmitting(true);
        try {
            await submitAnswer(params.id as string, payload);
            // refresh so task.answer reflects the judged result
            setTask(await getTask(params.id as string));
        } catch {
            setError("提交失败，请重试");
        }
        setSubmitting(false);
    }

    if (!task) {
        return (
            <div className="tq-page">
                <div className="tq-shell">
                    <p className="tq-empty">{error ?? "加载中…"}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="tq-page">
            <div className="tq-shell">
                <Link className="tq-back" href={`/tasks/${params.id}`}>← 返回详情</Link>

                <header className="tq-header">
                    <span className="tq-kicker">定时出题 · 作答</span>
                </header>

                {quiz ? (
                    <section className="tq-quiz-card">
                        <div className="tq-quiz-head">
                            <span className="tq-quiz-num">Q</span>
                            <span className="tq-quiz-type">
                                {TYPE_LABEL[quiz.question_type] || "题目"}
                            </span>
                        </div>
                        <div className="tq-question">
                            <MathText text={quiz.question} block />
                        </div>
                        {isChoice && quiz.options && (
                            <ol className="tq-options tq-options-interactive">
                                {quiz.options.map((o, i) => {
                                    let cls = "tq-option";
                                    if (selected === i) cls += " is-selected";
                                    if (revealed && quiz.answer === o) cls += " is-correct";
                                    if (revealed && selected === i && quiz.answer !== o)
                                        cls += " is-wrong";
                                    if (revealed) cls += " is-disabled";
                                    return (
                                        <li
                                            key={i}
                                            className={cls}
                                            onClick={() => !revealed && setSelected(i)}
                                        >
                                            <span className="tq-option-letter">
                                                {String.fromCharCode(65 + i)}
                                            </span>
                                            <span className="tq-option-text">
                                                <MathText text={o} />
                                            </span>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </section>
                ) : (
                    <div className="tq-empty">题目尚未生成（任务未到触发时间或出题失败）。</div>
                )}

                {!isChoice && !revealed && quiz && (
                    <textarea
                        className="tq-textarea"
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        placeholder="输入你的答案…"
                    />
                )}

                {revealed && task.answer && (
                    <section
                        className={`tq-result ${
                            task.answer.is_correct ? "tq-result-correct" : "tq-result-wrong"
                        }`}
                    >
                        <span className="tq-result-icon">
                            {task.answer.is_correct ? "✓" : "✗"}
                        </span>
                        <div className="tq-result-body">
                            <span className="tq-result-label">
                                {task.answer.is_correct ? "回答正确" : "回答错误"}
                            </span>
                            <span className="tq-result-answer">
                                <MathText text={task.answer.answer} />
                            </span>
                            {!task.answer.is_correct && quiz?.answer && (
                                <span className="tq-result-correct-answer">
                                    正确答案：<strong><MathText text={quiz.answer} /></strong>
                                </span>
                            )}
                        </div>
                    </section>
                )}

                {!revealed && quiz && (
                    <button
                        className="tq-cta"
                        onClick={submit}
                        disabled={submitting || !canSubmit}
                    >
                        {submitting ? "提交中…" : "提交答案"}
                    </button>
                )}

                <button
                    className="tq-back"
                    onClick={() => router.push(`/tasks/${params.id}`)}
                >
                    ← 返回详情
                </button>
            </div>
        </div>
    );
}
