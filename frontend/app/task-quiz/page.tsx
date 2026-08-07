'use client';

import { useState } from "react";
import { useRouter } from "next/navigation";
import { registerTask } from "@/lib/task-quiz-api";

export default function TaskQuizPage() {
    const router = useRouter();
    const [prompt, setPrompt] = useState("");
    const [triggerTime, setTriggerTime] = useState("");
    const [difficulty, setDifficulty] = useState("medium");
    const [ccEmails, setCcEmails] = useState("");
    const [incomplete, setIncomplete] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    async function submit() {
        if (!prompt.trim() || !triggerTime) return;
        setSubmitting(true);
        setError("");
        try {
            // datetime-local is local time -> convert to UTC ISO8601
            const utc = new Date(triggerTime).toISOString();
            const ccs = ccEmails.split(",").map((s) => s.trim()).filter(Boolean);
            await registerTask(prompt.trim(), utc, ccs, incomplete.trim() || undefined, difficulty);
            router.push("/tasks");
        } catch (e) {
            setError(e instanceof Error ? e.message : "提交失败");
        }
        setSubmitting(false);
    }

    const inputStyle: React.CSSProperties = {
        width: "100%",
        padding: "8px 12px",
        border: "1px solid #e5e6eb",
        borderRadius: 8,
        outline: "none",
        fontSize: 14,
        boxSizing: "border-box",
    };
    const labelStyle: React.CSSProperties = {
        display: "block",
        marginBottom: 4,
        color: "#4e5969",
        fontSize: 13,
    };
    const disabled = submitting || !prompt.trim() || !triggerTime;

    return (
        <div style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
            <h2 style={{ color: "#1f2329", marginBottom: 8 }}>定时出题任务</h2>
            <p style={{ color: "#86909c", fontSize: 13, marginBottom: 20 }}>
                设置出题方向和触发时间,到点系统自动出题并发邮件提醒(请在个人资料里先填好邮箱)。
            </p>

            <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>出题方向 *</label>
                <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    style={inputStyle}
                    placeholder="如:数学1填空题、英语阅读、政治马原、408数据结构等"
                    maxLength={500}
                />
            </div>

            <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>难度 *（考研难度）</label>
                <select
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value)}
                    style={inputStyle}
                >
                    <option value="easy">简单（基础概念题）</option>
                    <option value="medium">中等（常规应用题）</option>
                    <option value="hard">压轴题（综合难题）</option>
                </select>
            </div>

            <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>触发时间 * (本地时间,到点自动出题)</label>
                <input
                    type="datetime-local"
                    value={triggerTime}
                    onChange={(e) => setTriggerTime(e.target.value)}
                    style={inputStyle}
                    min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}
                />
            </div>

            <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>抄送人邮箱 (逗号分隔,可选)</label>
                <input
                    value={ccEmails}
                    onChange={(e) => setCcEmails(e.target.value)}
                    style={inputStyle}
                    placeholder="a@x.com, b@y.com"
                />
            </div>

            <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>未完成语录 (可选,留空用默认模板)</label>
                <textarea
                    value={incomplete}
                    onChange={(e) => setIncomplete(e.target.value)}
                    style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
                    placeholder="超时未答题时的提醒语"
                />
            </div>

            {error && (
                <p style={{ color: "#f53f3f", fontSize: 13, marginBottom: 12 }}>{error}</p>
            )}

            <button
                onClick={submit}
                disabled={disabled}
                style={{
                    padding: "8px 24px",
                    background: disabled ? "#c9cdd4" : "#3370ff",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: disabled ? "not-allowed" : "pointer",
                    fontSize: 14,
                }}
            >
                {submitting ? "提交中" : "提交任务"}
            </button>
        </div>
    );
}
