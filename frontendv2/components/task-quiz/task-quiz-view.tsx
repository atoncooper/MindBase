"use client";

/**
 * TaskQuizView - orchestrator for the 定时出题 page.
 *
 * Owns the list + detail state machine: loads the task list, fetches detail on
 * selection, handles new-task creation. Layout is a left list + right detail
 * (Apple Notes/Mail two-pane); on mobile only one pane shows at a time. Sent
 * tasks auto-refresh their detail every 30s so the answer countdown stays live.
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
    const [mobileDetail, setMobileDetail] = useState(false);

    const refreshList = useCallback(
        async (autoSelect: boolean) => {
            setLoading(true);
            try {
                const list = await taskQuizApi.listTasks();
                // Newest trigger first.
                list.sort((a, b) => b.triggerTime.localeCompare(a.triggerTime));
                setTasks(list);
                if (autoSelect && list.length > 0 && !selectedTaskId) {
                    setSelectedTaskId(list[0].taskId);
                }
            } catch {
                // Empty list is a valid state.
            } finally {
                setLoading(false);
            }
        },
        [selectedTaskId],
    );

    const refreshDetail = useCallback(async (taskId: string) => {
        setLoadingDetail(true);
        try {
            const d = await taskQuizApi.getTask(taskId);
            setDetail(d);
        } catch {
            // Keep stale detail on transient error.
        } finally {
            setLoadingDetail(false);
        }
    }, []);

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

    const handleSelect = useCallback((taskId: string) => {
        setSelectedTaskId(taskId);
        setDetail(null); // clear stale so loader shows
        setMobileDetail(true);
    }, []);

    const handleNew = useCallback(() => setDialogOpen(true), []);

    const handleCreated = useCallback(() => {
        void refreshList(false);
    }, [refreshList]);

    const handleAnswered = useCallback(() => {
        if (selectedTaskId) void refreshDetail(selectedTaskId);
    }, [selectedTaskId, refreshDetail]);

    const handleBack = useCallback(() => setMobileDetail(false), []);

    return (
        <div className="flex h-[calc(100dvh-3rem)]">
            {/* Left list */}
            <aside
                className={cn(
                    "w-[320px] shrink-0 border-r border-border-subtle",
                    mobileDetail && "hidden md:flex",
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

            {/* Right detail */}
            <section
                className={cn(
                    "min-w-0 flex-1",
                    !mobileDetail && "hidden md:block",
                )}
            >
                <TaskQuizDetailPanel
                    detail={detail}
                    loading={loadingDetail}
                    onAnswered={handleAnswered}
                    onBack={handleBack}
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
