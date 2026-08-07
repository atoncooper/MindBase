"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Loader2, CheckCircle2, History } from "lucide-react";
import { registerTask } from "@/lib/task-quiz-api";
import type { DockPanelProps } from "@/lib/dock-registry";

/**
 * 定时出题任务 dock panel. User fills prompt + trigger time (+ optional cc /
 * incomplete message); on submit registers a task on app-task (via main app
 * /task-quiz/register). The app-task scheduler fires execute_quiz at trigger_time
 * -> generates quiz + sends reminder email.
 */
export default function TaskQuizPanel({ isOpen }: DockPanelProps) {
    const router = useRouter();
    const [prompt, setPrompt] = useState("");
    const [triggerTime, setTriggerTime] = useState("");
    const [difficulty, setDifficulty] = useState("medium");
    const [ccEmails, setCcEmails] = useState("");
    const [incomplete, setIncomplete] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successTaskId, setSuccessTaskId] = useState<string | null>(null);

    if (!isOpen) return null;

    async function submit() {
        if (!prompt.trim() || !triggerTime) return;
        setSubmitting(true);
        setError(null);
        setSuccessTaskId(null);
        try {
            // datetime-local is local time -> convert to UTC ISO8601
            const utc = new Date(triggerTime).toISOString();
            const ccs = ccEmails.split(",").map((s) => s.trim()).filter(Boolean);
            const res = await registerTask(
                prompt.trim(),
                utc,
                ccs,
                incomplete.trim() || undefined,
                difficulty,
            );
            setSuccessTaskId(res.task_id);
            setPrompt("");
            setTriggerTime("");
            setCcEmails("");
            setIncomplete("");
            // jump to the history list so the user sees the newly scheduled task
            setTimeout(() => router.push("/tasks"), 1200);
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        }
        setSubmitting(false);
    }

    const disabled = submitting || !prompt.trim() || !triggerTime;

    const inputStyle: React.CSSProperties = {
        width: "100%",
        padding: "8px 12px",
        border: "1px solid var(--border, #e5e6eb)",
        borderRadius: 8,
        outline: "none",
        fontSize: 14,
        boxSizing: "border-box",
        background: "var(--card, #fff)",
        color: "var(--foreground, #1f2329)",
    };
    const labelStyle: React.CSSProperties = {
        display: "block",
        marginBottom: 4,
        color: "var(--muted-foreground, #86909c)",
        fontSize: 13,
    };

    return (
        <div
            style={{
                padding: 20,
                overflow: "auto",
                flex: 1,
                color: "var(--foreground)",
                fontFamily: "system-ui, -apple-system, sans-serif",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <CalendarClock size={18} style={{ color: "#3370ff" }} />
                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>定时出题任务</h3>
                </div>
                <Link
                    href="/tasks"
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 13,
                        color: "#3370ff",
                        textDecoration: "none",
                    }}
                >
                    <History size={14} />
                    历史任务
                </Link>
            </div>
            <p
                style={{
                    color: "var(--muted-foreground, #86909c)",
                    fontSize: 13,
                    margin: "0 0 18px",
                }}
            >
                设置出题方向和触发时间,到点系统自动出题并发邮件提醒(请先在个人中心填好邮箱)。
            </p>

            {successTaskId && (
                <div
                    style={{
                        padding: "12px 14px",
                        borderRadius: 8,
                        background: "rgba(22,163,74,.08)",
                        color: "#16a34a",
                        fontSize: 13,
                        marginBottom: 14,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <CheckCircle2 size={15} />
                    <span>
                        提交成功!任务 {successTaskId.slice(0, 8)}… 已排期,到点自动出题+发邮件。
                    </span>
                </div>
            )}
            {error && (
                <div
                    style={{
                        padding: "10px 14px",
                        borderRadius: 8,
                        background: "rgba(220,38,38,.08)",
                        color: "#f87171",
                        fontSize: 13,
                        marginBottom: 14,
                    }}
                >
                    {error}
                </div>
            )}

            <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>出题方向 *</label>
                <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    style={inputStyle}
                    placeholder="如:数学1填空题、英语阅读、政治马原、408数据结构等"
                    maxLength={500}
                />
            </div>

            <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>难度 *（考研难度）</label>
                <div style={{ display: "flex", gap: 8 }}>
                    {[
                        { v: "easy", label: "简单", desc: "基础概念" },
                        { v: "medium", label: "中等", desc: "常规应用" },
                        { v: "hard", label: "压轴", desc: "综合难题" },
                    ].map((o) => {
                        const active = difficulty === o.v;
                        return (
                            <button
                                key={o.v}
                                type="button"
                                onClick={() => setDifficulty(o.v)}
                                style={{
                                    flex: 1,
                                    padding: "8px 6px",
                                    border: active ? "1px solid #3370ff" : "1px solid var(--border, #e5e6eb)",
                                    borderRadius: 8,
                                    background: active ? "rgba(51,112,255,.08)" : "var(--card, #fff)",
                                    color: active ? "#3370ff" : "var(--foreground, #1f2329)",
                                    cursor: "pointer",
                                    textAlign: "center",
                                    transition: "all .15s ease",
                                    boxSizing: "border-box",
                                }}
                            >
                                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{o.label}</div>
                                <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.4 }}>{o.desc}</div>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>触发时间 * (本地时间,到点自动出题)</label>
                <input
                    type="datetime-local"
                    value={triggerTime}
                    onChange={(e) => setTriggerTime(e.target.value)}
                    style={inputStyle}
                    min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}
                />
            </div>

            <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>抄送人邮箱 (逗号分隔,可选)</label>
                <input
                    value={ccEmails}
                    onChange={(e) => setCcEmails(e.target.value)}
                    style={inputStyle}
                    placeholder="a@x.com, b@y.com"
                />
            </div>

            <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>未完成语录 (可选,留空用默认模板)</label>
                <textarea
                    value={incomplete}
                    onChange={(e) => setIncomplete(e.target.value)}
                    style={{ ...inputStyle, minHeight: 70, resize: "vertical" }}
                    placeholder="超时未答题时的提醒语"
                />
            </div>

            <button
                onClick={submit}
                disabled={disabled}
                style={{
                    padding: "8px 24px",
                    background: disabled ? "var(--muted, #c9cdd4)" : "#3370ff",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: disabled ? "not-allowed" : "pointer",
                    fontSize: 14,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                }}
            >
                {submitting ? (
                    <>
                        <Loader2 size={14} className="animate-spin" />
                        提交中
                    </>
                ) : (
                    "提交任务"
                )}
            </button>

            <style jsx global>{`
                @keyframes tqSpin {
                    to {
                        transform: rotate(360deg);
                    }
                }
                .animate-spin {
                    animation: tqSpin 1s linear infinite;
                }
            `}</style>
        </div>
    );
}
