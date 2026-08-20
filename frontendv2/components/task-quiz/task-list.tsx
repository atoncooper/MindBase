"use client";

/**
 * TaskQuizList - left sidebar of the task-quiz view.
 *
 * Searchable, status-grouped list of scheduled quiz tasks. Each row shows the
 * prompt, trigger time, and a status dot. The active task gets a left accent
 * bar (Apple Notes/Mail sidebar cue). Groups are ordered by urgency:
 * 待答题 > 待触发 > 已超时 > 失败 > 已完成.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, X, Plus, CalendarClock } from "lucide-react";
import type { TaskQuizListItem, TaskQuizStatus } from "@/lib/api/task-quiz";
import { cn } from "@/lib/utils";

interface TaskQuizListProps {
    tasks: TaskQuizListItem[];
    loading: boolean;
    selectedTaskId: string | null;
    onSelect: (taskId: string) => void;
    onNew: () => void;
}

interface Group {
    label: string;
    items: TaskQuizListItem[];
}

const STATUS_DOT: Record<TaskQuizStatus, string> = {
    pending: "bg-tertiary",
    running: "bg-accent",
    generating: "bg-accent",
    awaiting_answer: "bg-warning",
    completed: "bg-success",
    overdue: "bg-secondary",
    failed: "bg-danger",
};

const STATUS_LABEL: Record<TaskQuizStatus, string> = {
    pending: "待触发",
    running: "执行中",
    generating: "出题中",
    awaiting_answer: "待作答",
    completed: "已完成",
    overdue: "已超时",
    failed: "失败",
};

const GROUP_ORDER: { key: TaskQuizStatus; label: string }[] = [
    { key: "awaiting_answer", label: "待作答" },
    { key: "pending", label: "待触发" },
    { key: "running", label: "执行中" },
    { key: "overdue", label: "已超时" },
    { key: "failed", label: "失败" },
    { key: "completed", label: "已完成" },
];

/** Row title: quiz prompt from the scheduler's opaque payload, else task type. */
function listTitle(t: TaskQuizListItem): string {
    return t.payload?.prompt || t.taskType;
}

function formatTrigger(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    ).getTime();
    const ts = d.getTime();
    const dayMs = 86400000;
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
    ).padStart(2, "0")}`;
    if (ts >= startOfToday && ts < startOfToday + dayMs) return `今天 ${time}`;
    if (ts >= startOfToday - dayMs && ts < startOfToday) return `昨天 ${time}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

function groupTasks(tasks: TaskQuizListItem[]): Group[] {
    const buckets = new Map<TaskQuizStatus, TaskQuizListItem[]>();
    for (const t of tasks) {
        if (!buckets.has(t.status)) buckets.set(t.status, []);
        buckets.get(t.status)!.push(t);
    }
    const groups: Group[] = [];
    for (const g of GROUP_ORDER) {
        const items = buckets.get(g.key);
        if (items?.length) {
            // Within a group, nearest trigger time first.
            items.sort((a, b) => a.triggerTime.localeCompare(b.triggerTime));
            groups.push({ label: g.label, items });
        }
    }
    return groups;
}

export function TaskQuizList({
    tasks,
    loading,
    selectedTaskId,
    onSelect,
    onNew,
}: TaskQuizListProps) {
    const [query, setQuery] = useState("");

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return tasks;
        return tasks.filter((t) => listTitle(t).toLowerCase().includes(q));
    }, [tasks, query]);

    const groups = useMemo(() => groupTasks(filtered), [filtered]);

    return (
        <div className="flex h-full flex-col bg-surface">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-2.5 pt-4">
                <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                    定时出题
                </h2>
                <button
                    type="button"
                    onClick={onNew}
                    title="新建任务"
                    aria-label="新建任务"
                    className="grid h-7 w-7 place-items-center rounded-full text-secondary transition-all hover:bg-border-subtle hover:text-foreground active:scale-95"
                >
                    <Plus className="h-4 w-4" />
                </button>
            </div>

            {/* Search */}
            <div className="px-3 pb-2.5">
                <div
                    className={cn(
                        "flex h-8 items-center gap-2 rounded-[10px] border border-transparent bg-border-subtle/70 px-2.5 transition-colors",
                        "focus-within:bg-surface focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_rgba(0,113,227,0.12)]",
                    )}
                >
                    <Search className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索出题方向…"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-tertiary"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery("")}
                            aria-label="清除搜索"
                            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {loading && tasks.length === 0 ? (
                    <div className="space-y-0.5 px-1 pt-1">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="rounded-[10px] px-2.5 py-2.5">
                                <div className="h-3 w-2/3 animate-pulse rounded bg-border-subtle" />
                                <div className="mt-2 h-2 w-1/3 animate-pulse rounded bg-border-subtle/60" />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 px-6 pt-20 text-center">
                        {query ? (
                            <>
                                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-border-subtle">
                                    <Search className="h-4 w-4 text-tertiary" />
                                </div>
                                <div className="space-y-0.5">
                                    <p className="text-[13px] font-medium text-foreground/80">
                                        无匹配任务
                                    </p>
                                    <p className="text-[11px] text-tertiary">
                                        没有「{query}」相关的出题任务
                                    </p>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-border-subtle">
                                    <CalendarClock className="h-5 w-5 text-tertiary" />
                                </div>
                                <div className="space-y-0.5">
                                    <p className="text-[13px] font-medium text-foreground/80">
                                        还没有定时出题
                                    </p>
                                    <p className="text-[11px] text-tertiary">
                                        设置方向和时间，到点自动出题
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={onNew}
                                    className="rounded-full bg-accent-soft px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15"
                                >
                                    新建任务
                                </button>
                            </>
                        )}
                    </div>
                ) : (
                    groups.map((group) => (
                        <div key={group.label} className="mb-1.5">
                            <div className="flex items-center gap-2 px-2.5 pb-1 pt-3">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-tertiary">
                                    {group.label}
                                </span>
                                <span className="text-[10px] tabular-nums text-tertiary/60">
                                    {group.items.length}
                                </span>
                                <div className="h-px flex-1 bg-border-subtle" />
                            </div>
                            {group.items.map((task, i) => {
                                const isActive = task.taskId === selectedTaskId;
                                return (
                                    <motion.div
                                        key={task.taskId}
                                        initial={{ opacity: 0, y: 3 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{
                                            duration: 0.3,
                                            delay: Math.min(i * 0.018, 0.12),
                                            ease: [0.28, 0.11, 0.32, 1],
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => onSelect(task.taskId)}
                                            aria-current={isActive ? "true" : undefined}
                                            className={cn(
                                                "group relative w-full rounded-[10px] px-2.5 py-2.5 text-left transition-colors duration-150",
                                                isActive
                                                    ? "bg-accent-soft"
                                                    : "hover:bg-border-subtle/70",
                                            )}
                                        >
                                            {isActive && (
                                                <span className="absolute bottom-2 left-0 top-2 w-[2.5px] rounded-full bg-accent" />
                                            )}
                                            <p
                                                className={cn(
                                                    "min-w-0 truncate text-[13px] leading-snug",
                                                    isActive
                                                        ? "font-medium text-foreground"
                                                        : "text-foreground/90",
                                                )}
                                            >
                                                {listTitle(task)}
                                            </p>
                                            <div className="mt-1 flex items-center gap-1.5">
                                                <span
                                                    className={cn(
                                                        "h-1.5 w-1.5 shrink-0 rounded-full",
                                                        STATUS_DOT[task.status],
                                                    )}
                                                />
                                                <span className="min-w-0 shrink-0 text-[11px] text-secondary">
                                                    {STATUS_LABEL[task.status]}
                                                </span>
                                                <span className="text-tertiary/60">·</span>
                                                <span className="min-w-0 truncate text-[11px] text-tertiary">
                                                    {formatTrigger(task.triggerTime)}
                                                </span>
                                            </div>
                                        </button>
                                    </motion.div>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>

            {/* Footer */}
            {!loading && tasks.length > 0 && (
                <div className="border-t border-border-subtle px-4 py-2">
                    <span className="text-[10px] tabular-nums text-tertiary/70">
                        共 {tasks.length} 个任务
                    </span>
                </div>
            )}
        </div>
    );
}
