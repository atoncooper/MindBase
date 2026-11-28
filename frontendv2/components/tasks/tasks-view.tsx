"use client";

import { useCallback, useEffect, useState } from "react";
import {
    CalendarClock,
    ChevronRight,
    Clock3,
    FileText,
    Loader2,
    Newspaper,
    Pause,
    Play,
    Plus,
    RefreshCw,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import { academicApi, aiTaskApi, type AcademicProjectSummary, type AiTask, type AiTaskCreateInput, type AiTaskKind, type AiTaskRun, type AiTaskSchedule } from "@/lib/api";
import { emitAppToast } from "@/lib/app-toast";
import { Markdown } from "@/components/markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";

const KIND_META: Record<AiTaskKind, { label: string; icon: typeof Newspaper; hint: string }> = {
    news: { label: "新闻摘要", icon: Newspaper, hint: "检索新闻并汇总要点" },
    literature: { label: "文献追踪", icon: FileText, hint: "在科研项目中检索新文献" },
    report: { label: "周期汇报", icon: CalendarClock, hint: "汇总项目/知识库进展" },
    custom: { label: "自定义", icon: Sparkles, hint: "任意可重复的 Agent 任务" },
};

const TEMPLATES: Array<{ kind: AiTaskKind; title: string; prompt: string; schedule: AiTaskSchedule }> = [
    {
        kind: "news",
        title: "每日 AI 新闻摘要",
        prompt: "检索过去 24 小时 AI 行业的重要新闻，挑选 5-8 条最有价值的信息，说明每条为什么重要，并附上来源链接。",
        schedule: { type: "daily", timezone: "Asia/Shanghai", time: "09:00" },
    },
    {
        kind: "literature",
        title: "科研文献追踪",
        prompt: "在绑定的科研项目中检索最近发表的相关文献，挑选 5-10 篇最相关的论文，给出标题、作者、年份、DOI 和一句话摘要。",
        schedule: { type: "weekly", timezone: "Asia/Shanghai", time: "09:00", weekday: 1 },
    },
    {
        kind: "report",
        title: "项目周报",
        prompt: "汇总当前科研项目/知识库本周的进展、关键变化和下一步建议，输出一份可直接转发的周报。",
        schedule: { type: "weekly", timezone: "Asia/Shanghai", time: "18:00", weekday: 5 },
    },
];

type EditorState = {
    id?: string;
    title: string;
    prompt: string;
    kind: AiTaskKind;
    schedule: AiTaskSchedule;
    notifyEmail: boolean;
    notifyPush: boolean;
    academicProjectId: string;
};

const EMPTY_EDITOR: EditorState = {
    title: "",
    prompt: "",
    kind: "custom",
    schedule: { type: "daily", timezone: "Asia/Shanghai", time: "09:00" },
    notifyEmail: true,
    notifyPush: true,
    academicProjectId: "",
};

export function TasksView() {
    const [tasks, setTasks] = useState<AiTask[]>([]);
    const [projects, setProjects] = useState<AcademicProjectSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [runsTask, setRunsTask] = useState<AiTask | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AiTask | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await aiTaskApi.list();
            setTasks(res.tasks);
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "任务加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        academicApi
            .listProjects()
            .then((res) => setProjects(res.projects))
            .catch(() => setProjects([]));
        const timer = window.setInterval(() => void refresh(), 20_000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    async function handleRunNow(task: AiTask) {
        setBusyId(task.id);
        try {
            await aiTaskApi.runNow(task.id);
            emitAppToast("success", "已开始执行，报告生成后会出现在运行记录中");
            window.setTimeout(() => void refresh(), 2500);
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "启动失败");
        } finally {
            setBusyId(null);
        }
    }

    async function handleToggle(task: AiTask) {
        setBusyId(task.id);
        try {
            await (task.status === "paused" ? aiTaskApi.resume(task.id) : aiTaskApi.pause(task.id));
            await refresh();
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "操作失败");
        } finally {
            setBusyId(null);
        }
    }

    function handleDelete(task: AiTask) {
        if (busyId) return;
        setDeleteTarget(task);
    }

    async function performDelete() {
        const task = deleteTarget;
        if (!task) return;
        setBusyId(task.id);
        try {
            await aiTaskApi.remove(task.id);
            setDeleteTarget(null);
            await refresh();
            emitAppToast("success", "任务已删除");
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "删除失败");
        } finally {
            setBusyId(null);
        }
    }

    function openCreate() {
        setEditor({ ...EMPTY_EDITOR, schedule: { ...EMPTY_EDITOR.schedule } });
    }

    function openEdit(task: AiTask) {
        setEditor({
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            kind: task.kind,
            schedule: { ...task.schedule },
            notifyEmail: task.notifyEmail !== false,
            notifyPush: task.notifyPush !== false,
            academicProjectId: task.academicProjectId ?? "",
        });
    }

    const activeCount = tasks.filter((task) => task.status === "active").length;
    const nextTask = tasks
        .filter((task) => task.status === "active" && task.nextRunAt)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];

    return (
        <div className="min-h-[calc(100dvh-3rem)] bg-[#f5f6f8]">
            <div className="mx-auto w-full max-w-[1120px] px-5 py-8 sm:px-8 sm:py-10">
                <header className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="flex items-center gap-1.5 text-[12px] text-tertiary">
                            <Sparkles className="h-3.5 w-3.5 text-accent" />
                            自动化
                        </p>
                        <h1 className="mt-2 text-[26px] font-medium leading-8 text-foreground">AI 定时任务</h1>
                        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-secondary">
                            让 Agent 按计划收集信息、总结新闻、追踪文献并生成汇报。运行历史独立保存，不占用对话列表。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={openCreate}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#0b57d0] px-4 text-[12px] font-medium text-white shadow-sm transition-opacity hover:opacity-90"
                    >
                        <Plus className="h-4 w-4" />
                        新建任务
                    </button>
                </header>

                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    <Stat label="进行中" value={String(activeCount)} hint="按计划运行的任务" />
                    <Stat
                        label="下次运行"
                        value={nextTask?.nextRunAt ? formatDateTime(nextTask.nextRunAt) : "暂无"}
                        hint={nextTask?.title ?? "新建一个任务开始"}
                    />
                    <Stat label="累计运行" value={String(tasks.reduce((sum, task) => sum + task.runCount, 0))} hint="所有任务的执行次数" />
                </div>

                {loading ? (
                    <div className="mt-6 grid gap-3 md:grid-cols-2">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-56 animate-pulse rounded-2xl border border-border-subtle bg-surface" />
                        ))}
                    </div>
                ) : tasks.length === 0 ? (
                    <div className="mt-6 rounded-2xl border border-border-subtle bg-surface px-6 py-16 text-center">
                        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
                            <CalendarClock className="h-5 w-5" />
                        </span>
                        <h2 className="mt-4 text-[15px] font-medium text-foreground">还没有定时任务</h2>
                        <p className="mt-1 text-[12px] text-secondary">从新闻摘要、文献追踪或项目周报开始。</p>
                        <button
                            type="button"
                            onClick={openCreate}
                            className="mt-5 inline-flex h-9 items-center gap-1 rounded-md bg-[#0b57d0] px-4 text-[12px] font-medium text-white"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            创建第一个任务
                        </button>
                    </div>
                ) : (
                    <div className="mt-6 grid gap-3 md:grid-cols-2">
                        {tasks.map((task) => {
                            const meta = KIND_META[task.kind];
                            const Icon = meta.icon;
                            const paused = task.status === "paused";
                            const completed = task.status === "completed";
                            return (
                                <article
                                    key={task.id}
                                    className="flex flex-col rounded-2xl border border-border-subtle bg-surface p-5 shadow-[0_1px_2px_rgba(60,64,67,0.04)]"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f5f6f8] px-2.5 py-1 text-[11px] text-secondary">
                                            <Icon className="h-3.5 w-3.5 text-tertiary" />
                                            {meta.label}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-1.5">
                                            <span
                                                className={cn(
                                                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                                    task.status === "active" && "bg-emerald-50 text-emerald-700",
                                                    paused && "bg-amber-50 text-amber-700",
                                                    completed && "bg-zinc-100 text-zinc-500"
                                                )}
                                            >
                                                {task.status === "active" ? "运行中" : paused ? "已暂停" : "已完成"}
                                            </span>
                                        </div>
                                    </div>

                                    <h2 className="mt-3 text-[16px] font-semibold text-foreground">{task.title}</h2>
                                    <p className="mt-1.5 line-clamp-2 min-h-[2.8em] text-[12px] leading-relaxed text-secondary">
                                        {task.prompt}
                                    </p>

                                    <dl className="mt-4 space-y-1.5 border-t border-border-subtle pt-3 text-[12px]">
                                        <div className="flex items-center justify-between gap-3">
                                            <dt className="flex items-center gap-1.5 text-tertiary">
                                                <Clock3 className="h-3.5 w-3.5" />
                                                计划
                                            </dt>
                                            <dd className="text-right text-secondary">{task.scheduleLabel}</dd>
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <dt className="text-tertiary">下次运行</dt>
                                            <dd className="text-right text-secondary">
                                                {task.nextRunAt ? formatDateTime(task.nextRunAt) : "—"}
                                            </dd>
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <dt className="text-tertiary">上次结果</dt>
                                            <dd className={cn("text-right", task.lastRunStatus === "failed" ? "text-danger" : "text-secondary")}>
                                                {task.lastRunStatus === "succeeded"
                                                    ? "成功"
                                                    : task.lastRunStatus === "failed"
                                                      ? "失败"
                                                      : task.lastRunStatus === "running"
                                                        ? "运行中"
                                                        : task.lastRunStatus === "cancelled"
                                                          ? "已取消"
                                                          : "尚未运行"}
                                                {task.lastRunAt ? " · " + formatDateTime(task.lastRunAt) : ""}
                                            </dd>
                                        </div>
                                    </dl>

                                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
                                        <button
                                            type="button"
                                            onClick={() => setRunsTask(task)}
                                            className="inline-flex items-center gap-1 text-[12px] font-medium text-foreground hover:text-accent"
                                        >
                                            运行记录
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </button>
                                        <div className="flex items-center gap-2">
                                            {!completed && (
                                                <button
                                                    type="button"
                                                    disabled={busyId === task.id}
                                                    onClick={() => void handleRunNow(task)}
                                                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[#f5f6f8] px-3 text-[11px] text-secondary transition-colors hover:bg-[#ececf0] hover:text-foreground disabled:opacity-50"
                                                >
                                                    {busyId === task.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                                                    立即运行
                                                </button>
                                            )}
                                            {!completed && (
                                                <button
                                                    type="button"
                                                    disabled={busyId === task.id}
                                                    onClick={() => void handleToggle(task)}
                                                    className="grid h-8 w-8 place-items-center rounded-full text-tertiary transition-colors hover:bg-[#f5f6f8] hover:text-foreground disabled:opacity-50"
                                                    title={paused ? "恢复" : "暂停"}
                                                >
                                                    {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => openEdit(task)}
                                                className="rounded-full px-2 py-1 text-[11px] text-tertiary transition-colors hover:bg-[#f5f6f8] hover:text-foreground"
                                            >
                                                编辑
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleDelete(task)}
                                                className="grid h-8 w-8 place-items-center rounded-full text-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                                                title="删除任务"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>

            <ConfirmDialog
                open={deleteTarget !== null}
                title="删除这个定时任务？"
                message={
                    deleteTarget
                        ? `「${deleteTarget.title}」及其运行记录将一并删除，此操作不可撤销。`
                        : ""
                }
                confirmLabel="删除"
                danger
                busy={busyId !== null && busyId === deleteTarget?.id}
                onConfirm={() => void performDelete()}
                onCancel={() => {
                    if (busyId !== null) return;
                    setDeleteTarget(null);
                }}
            />

            {editor && (
                <TaskEditor
                    initial={editor}
                    projects={projects}
                    onClose={() => setEditor(null)}
                    onSaved={async () => {
                        setEditor(null);
                        await refresh();
                    }}
                />
            )}
            {runsTask && <TaskRuns task={runsTask} onClose={() => setRunsTask(null)} />}
        </div>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-3.5">
            <p className="text-[11px] text-tertiary">{label}</p>
            <p className="mt-1 truncate text-[17px] font-medium text-foreground">{value}</p>
            <p className="mt-0.5 truncate text-[11px] text-tertiary">{hint}</p>
        </div>
    );
}

function TaskEditor({
    initial,
    projects,
    onClose,
    onSaved,
}: {
    initial: EditorState;
    projects: AcademicProjectSummary[];
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const [form, setForm] = useState<EditorState>(initial);
    const [saving, setSaving] = useState(false);
    const isEdit = Boolean(initial.id);
    const meta = KIND_META[form.kind];

    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    function patch(next: Partial<EditorState>) {
        setForm((current) => ({ ...current, ...next }));
    }

    function patchSchedule(next: Partial<AiTaskSchedule>) {
        setForm((current) => ({ ...current, schedule: { ...current.schedule, ...next } }));
    }

    function pickTemplate(kind: AiTaskKind) {
        const template = TEMPLATES.find((item) => item.kind === kind);
        if (template) {
            setForm({
                title: template.title,
                prompt: template.prompt,
                kind: template.kind,
                schedule: { ...template.schedule },
                notifyEmail: form.notifyEmail,
                notifyPush: form.notifyPush,
                academicProjectId: form.academicProjectId,
            });
        }
    }

    async function submit() {
        if (!form.title.trim() || !form.prompt.trim()) {
            emitAppToast("warning", "请填写任务名称和指令");
            return;
        }
        if (form.kind === "literature" && !form.academicProjectId) {
            emitAppToast("warning", "文献追踪任务需要选择一个科研项目");
            return;
        }
        const schedule = normalizeScheduleForSubmit(form.schedule);
        if (!schedule) {
            emitAppToast("warning", "请填写有效的执行时间");
            return;
        }
        const body: AiTaskCreateInput = {
            title: form.title.trim(),
            prompt: form.prompt.trim(),
            kind: form.kind,
            schedule,
            notifyEmail: form.notifyEmail,
            notifyPush: form.notifyPush,
            ...(form.academicProjectId ? { academicProjectId: form.academicProjectId } : {}),
        };
        setSaving(true);
        if (form.notifyPush) void requestPushPermission();
        try {
            if (isEdit && initial.id) await aiTaskApi.update(initial.id, body);
            else await aiTaskApi.create(body);
            emitAppToast("success", isEdit ? "任务已更新" : "任务已创建");
            await onSaved();
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-3 backdrop-blur-[2px] sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
            <div
                className="flex max-h-[92vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
                    <div>
                        <h2 className="text-[16px] font-semibold text-foreground">{isEdit ? "编辑任务" : "新建定时任务"}</h2>
                        <p className="mt-0.5 text-[11px] text-tertiary">Agent 会按计划自动执行，并把报告保存到运行记录。</p>
                    </div>
                    <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-secondary hover:bg-[#f5f6f8]" aria-label="关闭">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    {!isEdit && (
                        <div className="mb-4 grid grid-cols-3 gap-2">
                            {TEMPLATES.map((template) => {
                                const Icon = KIND_META[template.kind].icon;
                                return (
                                    <button
                                        key={template.kind}
                                        type="button"
                                        onClick={() => pickTemplate(template.kind)}
                                        className={cn(
                                            "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                                            form.kind === template.kind
                                                ? "border-accent/40 bg-accent-soft/50"
                                                : "border-border-subtle hover:bg-[#fbfbfd]"
                                        )}
                                    >
                                        <Icon className="h-4 w-4 text-accent" />
                                        <span className="text-[12px] font-medium text-foreground">{template.title}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <label className="block text-[12px] font-medium text-foreground">
                        任务名称
                        <input
                            value={form.title}
                            onChange={(event) => patch({ title: event.target.value })}
                            maxLength={120}
                            placeholder="例如：每日 AI 新闻摘要"
                            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-[13px] font-normal outline-none transition-colors focus:border-accent"
                        />
                    </label>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="block text-[12px] font-medium text-foreground">
                            任务类型
                            <select
                                value={form.kind}
                                onChange={(event) => patch({ kind: event.target.value as AiTaskKind })}
                                className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-[13px] font-normal outline-none focus:border-accent"
                            >
                                {(Object.keys(KIND_META) as AiTaskKind[]).map((kind) => (
                                    <option key={kind} value={kind}>{KIND_META[kind].label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="block text-[12px] font-medium text-foreground">
                            科研项目（可选）
                            <select
                                value={form.academicProjectId}
                                onChange={(event) => patch({ academicProjectId: event.target.value })}
                                className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-[13px] font-normal outline-none focus:border-accent"
                            >
                                <option value="">不绑定</option>
                                {projects.map((project) => (
                                    <option key={project.id} value={project.id}>{project.title}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <label className="mt-3 block text-[12px] font-medium text-foreground">
                        任务指令
                        <textarea
                            value={form.prompt}
                            onChange={(event) => patch({ prompt: event.target.value })}
                            rows={5}
                            maxLength={20_000}
                            placeholder="描述要收集什么信息、如何筛选、输出什么格式。"
                            className="mt-1.5 max-h-[240px] w-full resize-y overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2.5 text-[13px] font-normal leading-relaxed outline-none transition-colors focus:border-accent"
                        />
                    </label>

                    <div className="mt-4 rounded-xl border border-border-subtle bg-[#fafafa] p-3.5">
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-[12px] font-medium text-foreground">触发计划</p>
                            <span className="text-[11px] text-tertiary">{meta.hint}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {(["daily", "weekly", "monthly", "once"] as const).map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    onClick={() => patchSchedule({ type, ...(type === "once" ? { runAt: defaultOnceAt() } : {}) })}
                                    className={cn(
                                        "rounded-full px-3 py-1.5 text-[11px] transition-colors",
                                        form.schedule.type === type
                                            ? "bg-[#0b57d0] text-white"
                                            : "bg-surface text-secondary hover:bg-[#ececf0]"
                                    )}
                                >
                                    {type === "daily" ? "每天" : type === "weekly" ? "每周" : type === "monthly" ? "每月" : "一次性"}
                                </button>
                            ))}
                        </div>

                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <label className="block text-[11px] text-tertiary">
                                时区
                                <select
                                    value={form.schedule.timezone}
                                    onChange={(event) => patchSchedule({ timezone: event.target.value })}
                                    className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] text-foreground outline-none focus:border-accent"
                                >
                                    {["Asia/Shanghai", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York", "America/Los_Angeles"].map((tz) => (
                                        <option key={tz} value={tz}>{tz}</option>
                                    ))}
                                </select>
                            </label>
                            {form.schedule.type === "once" ? (
                                <label className="block text-[11px] text-tertiary">
                                    执行时间
                                    <input
                                        type="datetime-local"
                                        value={toDateTimeLocal(form.schedule.runAt)}
                                        onChange={(event) => patchSchedule({ runAt: event.target.value ? new Date(event.target.value).getTime() : undefined })}
                                        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] text-foreground outline-none focus:border-accent"
                                    />
                                </label>
                            ) : (
                                <label className="block text-[11px] text-tertiary">
                                    执行时间
                                    <input
                                        type="time"
                                        value={form.schedule.time ?? "09:00"}
                                        onChange={(event) => patchSchedule({ time: event.target.value })}
                                        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] text-foreground outline-none focus:border-accent"
                                    />
                                </label>
                            )}
                            {form.schedule.type === "weekly" && (
                                <label className="block text-[11px] text-tertiary">
                                    星期
                                    <select
                                        value={form.schedule.weekday ?? 1}
                                        onChange={(event) => patchSchedule({ weekday: Number(event.target.value) })}
                                        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] text-foreground outline-none focus:border-accent"
                                    >
                                        {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label, index) => (
                                            <option key={label} value={index + 1}>{label}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            {form.schedule.type === "monthly" && (
                                <label className="block text-[11px] text-tertiary">
                                    日期
                                    <input
                                        type="number"
                                        min={1}
                                        max={28}
                                        value={form.schedule.dayOfMonth ?? 1}
                                        onChange={(event) => patchSchedule({ dayOfMonth: Number(event.target.value) })}
                                        className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] text-foreground outline-none focus:border-accent"
                                    />
                                </label>
                            )}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border-subtle pt-3 text-[12px] text-secondary">
                            <label className="inline-flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={form.notifyEmail}
                                    onChange={(event) => patch({ notifyEmail: event.target.checked })}
                                    className="h-3.5 w-3.5 accent-[#1f2329]"
                                />
                                邮件通知
                            </label>
                            <label className="inline-flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={form.notifyPush}
                                    onChange={(event) => {
                                        patch({ notifyPush: event.target.checked });
                                        if (event.target.checked) void requestPushPermission();
                                    }}
                                    className="h-3.5 w-3.5 accent-[#1f2329]"
                                />
                                浏览器推送
                            </label>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3.5">
                    <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-[12px] text-secondary hover:bg-[#f5f6f8]">
                        取消
                    </button>
                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => void submit()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#0b57d0] px-4 text-[12px] font-medium text-white disabled:opacity-50"
                    >
                        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {isEdit ? "保存修改" : "创建任务"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function TaskRuns({ task, onClose }: { task: AiTask; onClose: () => void }) {
    const [runs, setRuns] = useState<AiTaskRun[]>([]);
    const [selected, setSelected] = useState<AiTaskRun | null>(null);
    const [loading, setLoading] = useState(true);
    const [cancelling, setCancelling] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await aiTaskApi.listRuns(task.id, 30);
            setRuns(res.runs);
            if (res.runs[0]) {
                const detail = await aiTaskApi.getRun(res.runs[0].id);
                setSelected(detail);
            }
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "运行记录加载失败");
        } finally {
            setLoading(false);
        }
    }, [task.id]);

    useEffect(() => {
        void load();
    }, [load]);

    // While a run is queued/running, keep the history fresh without a manual reload.
    useEffect(() => {
        if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
        const timer = window.setInterval(() => void load(), 6000);
        return () => window.clearInterval(timer);
    }, [runs, load]);

    async function cancelSelected() {
        if (!selected) return;
        setCancelling(true);
        try {
            const updated = await aiTaskApi.cancelRun(selected.id);
            setSelected(updated);
            await load();
            emitAppToast("success", "已请求取消本次执行");
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "取消失败");
        } finally {
            setCancelling(false);
        }
    }

    async function openRun(run: AiTaskRun) {
        setSelected(run);
        try {
            setSelected(await aiTaskApi.getRun(run.id));
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "报告加载失败");
        }
    }

    return (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-3 backdrop-blur-[2px] sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
            <div
                className="flex h-[86vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
                    <div>
                        <h2 className="text-[16px] font-semibold text-foreground">{task.title}</h2>
                        <p className="mt-0.5 text-[11px] text-tertiary">{task.scheduleLabel} · 共 {runs.length} 次运行</p>
                    </div>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => void load()} className="grid h-8 w-8 place-items-center rounded-full text-secondary hover:bg-[#f5f6f8]" title="刷新">
                            <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-secondary hover:bg-[#f5f6f8]" aria-label="关闭">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="grid min-h-0 flex-1 md:grid-cols-[240px_1fr]">
                    <aside className="min-h-0 overflow-y-auto border-b border-border-subtle bg-[#fbfbfd] p-2 md:border-b-0 md:border-r">
                        {loading ? (
                            <p className="px-3 py-4 text-[12px] text-tertiary">加载中…</p>
                        ) : runs.length === 0 ? (
                            <p className="px-3 py-4 text-[12px] text-tertiary">还没有运行记录，点击任务卡片的「立即运行」试试。</p>
                        ) : (
                            runs.map((run) => (
                                <button
                                    key={run.id}
                                    type="button"
                                    onClick={() => void openRun(run)}
                                    className={cn(
                                        "mb-1 w-full rounded-xl px-3 py-2.5 text-left transition-colors",
                                        selected?.id === run.id ? "bg-surface shadow-sm" : "hover:bg-surface/70"
                                    )}
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="text-[12px] font-medium text-foreground">{formatDateTime(run.createdAt)}</span>
                                        <span
                                            className={cn(
                                                "rounded-full px-1.5 py-0.5 text-[10px]",
                                                run.status === "succeeded" && "bg-emerald-50 text-emerald-700",
                                                run.status === "failed" && "bg-danger/10 text-danger",
                                                run.status === "running" && "bg-amber-50 text-amber-700",
                                                run.status === "cancelled" && "bg-zinc-100 text-zinc-500",
                                                run.status === "queued" && "bg-zinc-100 text-zinc-500"
                                            )}
                                        >
                                            {run.status === "succeeded" ? "成功" : run.status === "failed" ? "失败" : run.status === "running" ? "运行中" : run.status === "cancelled" ? "已取消" : "排队"}
                                        </span>
                                    </span>
                                    <span className="mt-1 block truncate text-[11px] text-tertiary">
                                        {run.summary || run.error || "暂无摘要"}
                                    </span>
                                </button>
                            ))
                        )}
                    </aside>

                    <section className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7">
                        {!selected ? (
                            <div className="grid h-full place-items-center text-[12px] text-tertiary">选择一条运行记录查看报告</div>
                        ) : selected.status === "failed" && !selected.content ? (
                            <div className="rounded-xl border border-danger/20 bg-danger/5 p-4">
                                <p className="text-[13px] font-medium text-danger">本次运行失败</p>
                                <p className="mt-1 whitespace-pre-wrap text-[12px] text-secondary">{selected.error || "未知错误"}</p>
                            </div>
                        ) : selected.status === "cancelled" && !selected.content ? (
                            <div className="rounded-xl border border-border-subtle bg-[#fbfbfd] p-4">
                                <p className="text-[13px] font-medium text-foreground">本次运行已取消</p>
                                <p className="mt-1 text-[12px] text-secondary">{selected.error || "用户取消了执行"}</p>
                            </div>
                        ) : (
                            <>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-3">
                                    <p className="text-[11px] text-tertiary">
                                        {selected.finishedAt ? "完成于 " + formatDateTime(selected.finishedAt) : "运行中…"}
                                    </p>
                                </div>
                                {selected.error && (
                                    <p className="mb-3 rounded-lg bg-danger/5 px-3 py-2 text-[12px] text-danger">{selected.error}</p>
                                )}
                                {selected.content ? (
                                    <div className="md-body">
                                        <Markdown>{selected.content}</Markdown>
                                    </div>
                                ) : (
                                    <p className="text-[12px] text-tertiary">报告生成中，请稍后刷新。</p>
                                )}
                            </>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}

async function requestPushPermission(): Promise<void> {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
        await Notification.requestPermission().catch(() => undefined);
    }
}

function normalizeScheduleForSubmit(schedule: AiTaskSchedule): AiTaskSchedule | null {
    if (schedule.type === "once") {
        return schedule.runAt && schedule.runAt > Date.now() ? schedule : null;
    }
    if (!schedule.time) return null;
    if (schedule.type === "weekly" && !schedule.weekday) return null;
    if (schedule.type === "monthly" && !schedule.dayOfMonth) return null;
    return schedule;
}

function defaultOnceAt(): number {
    return Date.now() + 24 * 60 * 60_000;
}

function toDateTimeLocal(timestamp: number | undefined): string {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
