'use client';

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getTask, TaskDetail } from "@/lib/task-quiz-api";
import { MathText } from "@/components/MathText";

const STATUS_LABEL: Record<string, string> = {
    pending: "待触发",
    generating: "出题中",
    sent: "待作答",
    completed: "已完成",
    overdue: "已超时",
    failed: "失败",
};

const TYPE_LABEL: Record<string, string> = {
    choice: "选择题",
    fill_blank: "填空题",
    short_answer: "简答题",
};

export default function TaskDetailPage() {
    const params = useParams();
    const [task, setTask] = useState<TaskDetail | null>(null);

    useEffect(() => {
        getTask(params.id as string).then(setTask).catch(console.error);
    }, [params.id]);

    if (!task) {
        return (
            <div className="tq-page">
                <div className="tq-shell">
                    <p className="tq-empty">加载中…</p>
                </div>
            </div>
        );
    }

    const quiz = task.quiz;
    const typeLabel = quiz ? (TYPE_LABEL[quiz.question_type] || "题目") : "";

    return (
        <div className="tq-page">
            <div className="tq-shell">
                <Link className="tq-back" href="/">← 回主页</Link>

                <header className="tq-header">
                    <span className="tq-kicker">定时出题 · 任务详情</span>
                    <span className={`tq-status tq-status-${task.status}`}>
                        {STATUS_LABEL[task.status] || task.status}
                    </span>
                </header>

                <section className="tq-meta">
                    <div className="tq-meta-row">
                        <span className="tq-meta-label">出题方向</span>
                        <span className="tq-meta-value">{task.prompt}</span>
                    </div>
                    <div className="tq-meta-row">
                        <span className="tq-meta-label">触发时间</span>
                        <span className="tq-meta-value">
                            {new Date(task.trigger_time).toLocaleString("zh-CN")}
                        </span>
                    </div>
                    {task.cc_emails?.length > 0 && (
                        <div className="tq-meta-row">
                            <span className="tq-meta-label">抄送</span>
                            <span className="tq-meta-value">{task.cc_emails.join(", ")}</span>
                        </div>
                    )}
                </section>

                {quiz ? (
                    <section className="tq-quiz-card">
                        <div className="tq-quiz-head">
                            <span className="tq-quiz-num">Q</span>
                            <span className="tq-quiz-type">{typeLabel}</span>
                        </div>
                        <div className="tq-question">
                            <MathText text={quiz.question} block />
                        </div>
                        {quiz.options && (
                            <ol className="tq-options">
                                {quiz.options.map((o, i) => (
                                    <li key={i} className="tq-option">
                                        <span className="tq-option-letter">
                                            {String.fromCharCode(65 + i)}
                                        </span>
                                        <span className="tq-option-text">
                                            <MathText text={o} />
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </section>
                ) : (
                    <div className="tq-empty">题目尚未生成（任务未到触发时间或出题失败）。</div>
                )}

                {task.answer ? (
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
                ) : (
                    task.status === "sent" && quiz && (
                        <Link className="tq-cta" href={`/tasks/${task.task_id}/answer`}>
                            去答题 →
                        </Link>
                    )
                )}

                <Link className="tq-back" href="/tasks">← 返回列表</Link>
            </div>
        </div>
    );
}
