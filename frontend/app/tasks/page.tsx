'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import { listTasks, TaskListItem } from "@/lib/task-quiz-api";

const STATUS_COLOR: Record<string, string> = {
    pending: "#86909c",
    sent: "#3370ff",
    completed: "#00b42a",
    overdue: "#f53f3f",
    failed: "#f53f3f",
};

export default function TasksPage() {
    const [tasks, setTasks] = useState<TaskListItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        try {
            listTasks()
                .then(setTasks)
                .catch(console.error)
                .finally(() => setLoading(false));
        } catch {
            setLoading(false);
        }
    }, []);

    return (
        <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
            <div style={{ marginBottom: 12 }}>
                <Link href="/" style={{ color: "#3370ff", textDecoration: "none", fontSize: 14 }}>← 回主页</Link>
            </div>
            <h2 style={{ color: "#1f2329" }}>我的任务</h2>
            {loading ? (
                <p>加载中...</p>
            ) : tasks.length === 0 ? (
                <p style={{ color: "#86909c" }}>暂无任务</p>
            ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #e5e6eb" }}>出题方向</th>
                            <th style={{ padding: 8, borderBottom: "1px solid #e5e6eb" }}>触发时间</th>
                            <th style={{ padding: 8, borderBottom: "1px solid #e5e6eb" }}>状态</th>
                            <th style={{ padding: 8, borderBottom: "1px solid #e5e6eb" }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {tasks.map((t) => (
                            <tr key={t.task_id}>
                                <td style={{ padding: 8, borderBottom: "1px solid #f2f3f5" }}>{t.prompt}</td>
                                <td style={{ padding: 8, borderBottom: "1px solid #f2f3f5" }}>
                                    {new Date(t.trigger_time).toLocaleString("zh-CN")}
                                </td>
                                <td style={{ padding: 8, textAlign: "center", borderBottom: "1px solid #f2f3f5" }}>
                                    <span style={{ color: STATUS_COLOR[t.status] || "#86909c" }}>{t.status}</span>
                                </td>
                                <td style={{ padding: 8, borderBottom: "1px solid #f2f3f5" }}>
                                    <Link href={`/tasks/${t.task_id}`} style={{ color: "#3370ff" }}>
                                        详情
                                    </Link>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div style={{ marginTop: 16 }}>
                <Link href="/task-quiz" style={{ color: "#3370ff" }}>
                    + 新建任务
                </Link>
            </div>
        </div>
    );
}
