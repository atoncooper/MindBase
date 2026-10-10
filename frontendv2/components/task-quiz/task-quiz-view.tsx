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
            // /tasks 是 app-task 的全用户任务表（调度器是通用执行器，
            // app-pay 订单超时委托等系统任务也注册在同一张表、uid 相同会一并返回）。
            // 本页面只关心出题任务：出题注册链路恒带 payload.prompt，其他域任务没有，
            // 据此过滤——否则这类任务没有业务行（/detail 恒 404），兜底映射会把
            // scheduler completed 渲染成"正在生成题目…"并永久转圈。
            const quizTasks = list.filter(
                (t) => typeof t.payload?.prompt === "string" && t.payload.prompt.trim().length > 0,
            );
            // Newest trigger first.
            quizTasks.sort((a, b) => b.triggerTime.localeCompare(a.triggerTime));
            setTasks(quizTasks);
            // 选中项仍存在于过滤后的列表则保留（避免点击任务时列表被整表重拉）；
            // 已消失（含被过滤的系统任务）则回落到第一个，空列表清空选中。
            setSelectedTaskId((prev) => {
                if (prev && quizTasks.some((t) => t.taskId === prev)) return prev;
                return quizTasks.length > 0 ? quizTasks[0].taskId : null;
            });
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
                    // completed 仅在业务行缺失（404 兜底）时到达这里——正常完成
                    // 会经 markTaskQuizGenerated 翻转业务行，detail 直接 200。
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

    const handleDeleted = useCallback(() => {
        // 删除成功：重拉列表；若删除的是当前选中项，refreshList 的函数式
        // 选中更新会自动回落到第一个任务（或清空）。
        void refreshList(false);
    }, [refreshList]);

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
                    onDeleted={handleDeleted}
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
