"use client";

import { useEffect } from "react";
import { aiTaskApi, type AiTask } from "@/lib/api";
import { emitAppToast } from "@/lib/app-toast";

const STORAGE_KEY = "mindbase.ai-task.last-runs";
const POLL_MS = 30_000;

function readLastRuns(): Record<string, string> {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, string>)
            : {};
    } catch {
        return {};
    }
}

function writeLastRuns(value: Record<string, string>): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
        // localStorage can be unavailable in private mode; notifications still work in-session.
    }
}

function runKeyOf(task: AiTask): string {
    if (task.lastRunId) return task.lastRunId;
    if (task.lastRunAt) return task.lastRunStatus + ":" + task.lastRunAt;
    return "";
}

function notify(task: AiTask): void {
    const ok = task.lastRunStatus === "succeeded";
    const title = ok ? "定时任务已完成" : "定时任务执行失败";
    const body = task.title + (ok ? " 的报告已生成" : "，请查看运行记录");
    emitAppToast(ok ? "success" : "error", title + "：" + task.title);
    try {
        if ("Notification" in window && Notification.permission === "granted") {
            new Notification(title, { body, tag: "ai-task-" + task.id, icon: "/favicon.ico" });
        }
    } catch {
        // Browser notification is best-effort; the toast already fired.
    }
}

/**
 * Global task-completion watcher. Email is sent by the backend; this hook keeps
 * the browser push side alive on every authenticated page, not only /tasks.
 */
export function useAiTaskNotifications(enabled: boolean): void {
    useEffect(() => {
        if (!enabled || typeof window === "undefined") return;
        let stopped = false;

        const poll = async () => {
            try {
                const res = await aiTaskApi.list();
                if (stopped) return;
                const lastRuns = readLastRuns();
                let changed = false;
                for (const task of res.tasks) {
                    const key = runKeyOf(task);
                    const previous = lastRuns[task.id];
                    if (previous && key && previous !== key && (task.lastRunStatus === "succeeded" || task.lastRunStatus === "failed")) {
                        if (task.notifyPush !== false) notify(task);
                        lastRuns[task.id] = key;
                        changed = true;
                    } else if (key && previous !== key) {
                        lastRuns[task.id] = key;
                        changed = true;
                    }
                }
                if (changed) writeLastRuns(lastRuns);
            } catch {
                // Background polling must never surface a toast just because the API blipped.
            }
        };

        void poll();
        const timer = window.setInterval(() => void poll(), POLL_MS);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [enabled]);
}
