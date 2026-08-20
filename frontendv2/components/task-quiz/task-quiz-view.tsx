"use client";

/**
 * TaskQuizView - orchestrator for the 定时出题 page.
 *
 * Owns the list + detail state machine: loads the task list, fetches detail on
 * selection, handles new-task creation. Layout is a left list + right detail
 * (Apple Notes/Mail two-pane); on mobile only one pane shows at a time. Tasks
 * awaiting an answer auto-refresh their detail every 30s so the countdown and
 * status transitions (awaiting_answer -> overdue) stay live.
 */
import { useCallback, useEffect, useState } from "react";
import { taskQuizApi, type TaskQuizListItem, type TaskQuizDetail } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TaskQuizList } from "./task-list";
import { TaskQuizDetail as TaskQuizDetailPanel } from "./task-detail";
import { NewTaskDialog } from "./new-task-dialog";

export function TaskQuizView() {
    const [tasks, setTasks] = useState<TaskQuizListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [detail, setDetail] = useState<TaskQuizDetail | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);

    const refreshList = useCallback(async (autoSelect: boolean) => {
        setLoading(true);
        try {
            const list = await taskQuizApi.listTasks();
            // Newest trigger first.
            list.sort((a, b) => b.triggerTime.localeCompare(a.triggerTime));
            setTasks(list);
            if (autoSelect && list.length > 0) {
                // 只在尚未选中任何任务时自动选中第一个（函数式更新，
                // 不依赖 selectedTaskId，避免点击任务时列表被整表重拉）。
                setSelectedTaskId((prev) => prev ?? list[0].taskId);
            }
        } catch {
            // Empty list is a valid state.
        } finally {
            setLoading(false);
        }
    }, []);

    const refreshDetail = useCallback(async (taskId: string) => {
        setLoadingDetail(true);
        try {
            const d = await taskQuizApi.getTask(taskId);
            setDetail(d);
        } catch {
            // The business row behind /detail is only created at generation
            // time, so tasks whose trigger has not fired yet 404. Fall back to
            // a scheduled view synthesized from the list item; keep any stale
            // detail for this task on transient errors so a loaded quiz never
            // regresses to the fallback.
            setDetail((prev) => {
                if (prev && prev.taskId === taskId) return prev;
                const item = tasks.find((t) => t.taskId === taskId);
                if (!item) return prev;
                return {
                    taskId: item.taskId,
                    prompt: item.payload?.prompt ?? item.taskType,
                    difficulty: item.payload?.difficulty ?? "",
                    // Scheduler -> business mapping: running/completed mean the
                    // executor phase (quiz generating); pending stays pending.
                    status:
                        item.status === "running" || item.status === "completed"
                            ? "generating"
                            : item.status === "failed"
                              ? "failed"
                              : "pending",
                    deadline: null,
                    triggerTime: item.triggerTime,
                    ccEmails: item.payload?.ccEmails ?? [],
                    quiz: null,
                    answers: [],
                };
            });
        } finally {
            setLoadingDetail(false);
        }
    }, [tasks]);

    // Initial load.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshList(true);
    }, [refreshList]);

    // Fetch detail whenever selection changes.
    useEffect(() => {
        if (!selectedTaskId) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshDetail(selectedTaskId);
    }, [selectedTaskId, refreshDetail]);

    // Auto-refresh the selected detail every 30s so sent-task countdowns and
    // status transitions (sent -> overdue) stay live without a manual reload.
    useEffect(() => {
        if (!selectedTaskId) return;
        const t = setInterval(() => {
            void refreshDetail(selectedTaskId);
        }, 30000);
        return () => clearInterval(t);
    }, [selectedTaskId, refreshDetail]);

    const handleSelect = useCallback(
        (taskId: string) => {
            if (selectedTaskId === taskId) {
                // 重复点击当前选中的任务：不清空详情，直接重新拉取，
                // 否则详情被置空后 selectedTaskId 不变、fetch effect 不触发，
                // 右侧面板会永远停留在空状态。
                void refreshDetail(taskId);
                return;
            }
            setSelectedTaskId(taskId);
            setDetail(null); // clear stale so loader shows
        },
        [selectedTaskId, refreshDetail],
    );

    const handleNew = useCallback(() => setDialogOpen(true), []);

    const handleCreated = useCallback(() => {
        void refreshList(false);
    }, [refreshList]);

    const handleAnswered = useCallback(() => {
        if (selectedTaskId) void refreshDetail(selectedTaskId);
        // 答题后任务状态变为 completed，同步刷新侧边栏列表的状态与分组。
        void refreshList(false);
    }, [selectedTaskId, refreshDetail, refreshList]);

    return (
        <div className="flex h-[calc(100dvh-3rem)]">
            {/* Left list — 任何宽度下都常驻显示，点击任务绝不收起/变窄；
                窄屏(<sm)只把宽度收窄到 240px，而不是隐藏 */}
            <aside
                className={cn(
                    "w-[320px] shrink-0 border-r border-border-subtle",
                    "max-sm:w-[240px]",
                )}
            >
                <TaskQuizList
                    tasks={tasks}
                    loading={loading}
                    selectedTaskId={selectedTaskId}
                    onSelect={handleSelect}
                    onNew={handleNew}
                />
            </aside>

            {/* Right detail — 始终与侧边栏并排 */}
            <section className="min-w-0 flex-1">
                <TaskQuizDetailPanel
                    detail={detail}
                    loading={loadingDetail}
                    onAnswered={handleAnswered}
                />
            </section>

            <NewTaskDialog
                open={dialogOpen}
                onClose={() => setDialogOpen(false)}
                onCreated={handleCreated}
            />
        </div>
    );
}
