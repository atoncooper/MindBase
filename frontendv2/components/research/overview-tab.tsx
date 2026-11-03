"use client";

/**
 * 概览 Tab：阶段推进/状态切换（均需用户二次确认）、阶段计划勾选、阶段建议编辑，
 * 以及文献/稿件计数。所有写操作都走 academicApi.updateProject 的 PATCH（按键合并），
 * 成功后由父组件静默刷新 detail 与项目摘要。
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ListChecks, Loader2, Save, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
    academicApi,
    type AcademicProjectDetail,
    type AcademicPlanTask,
    type AcademicStage,
    type AcademicStageStatePatch,
    type AcademicStageStatus,
} from "@/lib/api";
import {
    ErrorBanner,
    STAGE_LABELS,
    STAGE_ORDER,
    STAGE_STATUS_LABELS,
    StatusBadge,
    SurfaceCard,
    formatDateTime,
} from "./research-ui";

const STATUS_OPTIONS: AcademicStageStatus[] = ["active", "submitted", "approved", "frozen", "locked"];

interface PendingAction {
    title: string;
    message: string;
    confirmLabel: string;
    apply: () => Promise<void>;
}

export function OverviewTab({
    detail,
    onChanged,
}: {
    detail: AcademicProjectDetail;
    onChanged: () => Promise<void>;
}) {
    const { project } = detail;
    const [stage, setStage] = useState<AcademicStage>(project.stage);
    const [adviceDraft, setAdviceDraft] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // 切换项目 / 当前阶段时，把建议草稿重置为后端保存的内容。
    useEffect(() => {
        setStage(project.stage);
    }, [project.id, project.stage]);

    // 只在切换阶段/项目时载入草稿：静默刷新 detail 不应覆盖用户正在编辑的内容。
    useEffect(() => {
        setAdviceDraft(detail.advice[stage] ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随阶段/项目重置
    }, [stage, project.id]);

    const stageState = project.stages[stage];
    const tasks = useMemo(() => detail.plans[stage] ?? [], [detail.plans, stage]);
    const nextStage: AcademicStage | null = useMemo(() => {
        const index = STAGE_ORDER.indexOf(project.stage);
        return index >= 0 && index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : null;
    }, [project.stage]);

    async function run(label: string, action: () => Promise<void>) {
        setBusy(label);
        setError(null);
        setNotice(null);
        try {
            await action();
            await onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
        } finally {
            setBusy(null);
        }
    }

    function confirmAdvance() {
        if (!nextStage) return;
        setPending({
            title: `推进到「${STAGE_LABELS[nextStage]}」`,
            message: "确认把项目推进到下一阶段？推进后当前阶段视为已完成。",
            confirmLabel: "确认推进",
            apply: async () => {
                const stagesPatch: Partial<Record<AcademicStage, AcademicStageStatePatch>> = {};
                stagesPatch[nextStage] = { status: "active" };
                await academicApi.updateProject(project.id, { stage: nextStage, stages: stagesPatch });
                setNotice(`已推进到「${STAGE_LABELS[nextStage]}」阶段`);
            },
        });
    }

    function confirmStatus(status: AcademicStageStatus) {
        setPending({
            title: `更新「${STAGE_LABELS[stage]}」阶段状态`,
            message: `确认把该阶段状态改为「${STAGE_STATUS_LABELS[status]}」？`,
            confirmLabel: "确认更新",
            apply: async () => {
                const stagesPatch: Partial<Record<AcademicStage, AcademicStageStatePatch>> = {};
                stagesPatch[stage] = { status };
                await academicApi.updateProject(project.id, { stages: stagesPatch });
                setNotice(`「${STAGE_LABELS[stage]}」已标记为「${STAGE_STATUS_LABELS[status]}」`);
            },
        });
    }

    async function toggleTask(taskId: string) {
        const updated: AcademicPlanTask[] = tasks.map((task) =>
            task.id === taskId ? { ...task, done: !task.done } : task,
        );
        await run(`task-${taskId}`, async () => {
            await academicApi.updateProject(project.id, { plans: { [stage]: updated } });
        });
    }

    async function saveAdvice() {
        await run("advice", async () => {
            await academicApi.updateProject(project.id, { advice: { [stage]: adviceDraft } });
            setNotice("阶段建议已保存");
        });
    }

    const doneCount = tasks.filter((task) => task.done).length;

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} />}
            {notice && (
                <div className="flex items-center gap-2 rounded-lg border-l-2 border-success bg-success/5 px-3 py-2.5 text-[12px] text-success">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    {notice}
                </div>
            )}

            {/* 阶段状态 */}
            <SurfaceCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-semibold text-foreground">阶段状态</h3>
                        <StatusBadge status={stageState?.status ?? "locked"} />
                    </div>
                    <button
                        type="button"
                        onClick={confirmAdvance}
                        disabled={!nextStage || busy !== null}
                        className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                        {busy === "advance" && <Loader2 className="h-3 w-3 animate-spin" />}
                        {nextStage ? `推进到${STAGE_LABELS[nextStage]}` : "已是最后阶段"}
                        {nextStage && <ArrowRight className="h-3 w-3" />}
                    </button>
                </div>
                <p className="mt-1.5 text-[12px] text-secondary">
                    当前阶段「{STAGE_LABELS[project.stage]}」；阶段推进与状态变更都需要你确认后才会写入后端。
                </p>

                <div className="mt-3 flex flex-wrap gap-1.5">
                    {STATUS_OPTIONS.map((status) => {
                        const active = (stageState?.status ?? "locked") === status;
                        return (
                            <button
                                key={status}
                                type="button"
                                onClick={() => confirmStatus(status)}
                                disabled={busy !== null}
                                className={cn(
                                    "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
                                    active
                                        ? "border-accent bg-accent-soft text-accent"
                                        : "border-border bg-surface text-secondary hover:border-tertiary hover:text-foreground",
                                )}
                            >
                                {STAGE_STATUS_LABELS[status]}
                            </button>
                        );
                    })}
                </div>

                <div className="mt-3 flex items-center gap-1.5 overflow-x-auto border-t border-border-subtle pt-3">
                    {STAGE_ORDER.map((item) => (
                        <button
                            key={item}
                            type="button"
                            onClick={() => setStage(item)}
                            className={cn(
                                "shrink-0 rounded-full px-2.5 py-1 text-[11px] transition-colors",
                                item === stage
                                    ? "bg-foreground text-surface"
                                    : "text-secondary hover:bg-border-subtle hover:text-foreground",
                            )}
                        >
                            {STAGE_LABELS[item]}
                            {item === project.stage && <span className="ml-1 opacity-70">·当前</span>}
                        </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[11px] text-tertiary">
                    上方选择的是要查看计划/建议的阶段；阶段徽标显示该阶段自身状态。
                </p>
            </SurfaceCard>

            {/* 执行计划 */}
            <SurfaceCard>
                <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <ListChecks className="h-3.5 w-3.5" />
                        「{STAGE_LABELS[stage]}」执行计划
                    </h3>
                    <span className="text-[11px] text-tertiary">
                        {doneCount}/{tasks.length} 完成
                    </span>
                </div>
                {tasks.length === 0 ? (
                    <p className="mt-2 text-[12px] text-secondary">
                        该阶段还没有执行计划。可让学术 agent 用 plan_set 生成，或在对话中描述任务后重试。
                    </p>
                ) : (
                    <ul className="mt-2 space-y-1">
                        {tasks.map((task) => (
                            <li key={task.id}>
                                <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-border-subtle/60">
                                    <input
                                        type="checkbox"
                                        checked={task.done}
                                        disabled={busy !== null}
                                        onChange={() => void toggleTask(task.id)}
                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                                    />
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 text-[12px] leading-relaxed",
                                            task.done ? "text-tertiary line-through" : "text-foreground",
                                        )}
                                    >
                                        {task.title}
                                        {task.note && (
                                            <span className="ml-1 text-[11px] text-tertiary">（{task.note}）</span>
                                        )}
                                    </span>
                                    {busy === `task-${task.id}` && (
                                        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-tertiary" />
                                    )}
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </SurfaceCard>

            {/* 阶段建议 */}
            <SurfaceCard>
                <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Sparkles className="h-3.5 w-3.5" />
                        「{STAGE_LABELS[stage]}」阶段建议
                    </h3>
                    <button
                        type="button"
                        onClick={() => void saveAdvice()}
                        disabled={busy !== null || adviceDraft === (detail.advice[stage] ?? "")}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                    >
                        {busy === "advice" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <Save className="h-3 w-3" />
                        )}
                        保存建议
                    </button>
                </div>
                <textarea
                    value={adviceDraft}
                    onChange={(e) => setAdviceDraft(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="记录该阶段的指导建议、审稿意见或下一步动作；保存后会写入项目事件流。"
                    className="field mt-2 resize-y text-[12px]"
                />
                <p className="mt-1 text-[11px] text-tertiary">
                    保存空内容可清空该阶段建议；内容会出现在项目简报与动态中。
                </p>
            </SurfaceCard>

            {/* 统计 */}
            <div className="grid grid-cols-2 gap-3">
                <SurfaceCard>
                    <div className="text-[11px] text-tertiary">文献库</div>
                    <div className="mt-1 text-[20px] font-semibold text-foreground">
                        {project.literatureCount}
                        <span className="ml-1 text-[12px] font-normal text-secondary">篇</span>
                    </div>
                </SurfaceCard>
                <SurfaceCard>
                    <div className="text-[11px] text-tertiary">写作稿件</div>
                    <div className="mt-1 text-[20px] font-semibold text-foreground">
                        {project.documentCount}
                        <span className="ml-1 text-[12px] font-normal text-secondary">篇</span>
                    </div>
                </SurfaceCard>
            </div>

            <p className="text-[11px] text-tertiary">
                创建于 {formatDateTime(project.createdAt)} · 最近更新 {formatDateTime(project.updatedAt)}
            </p>

            <ConfirmDialog
                open={pending !== null}
                title={pending?.title ?? ""}
                message={pending?.message}
                confirmLabel={pending?.confirmLabel ?? "确认"}
                busy={busy !== null}
                onCancel={() => setPending(null)}
                onConfirm={() => {
                    const action = pending;
                    setPending(null);
                    if (action) void run("advance", action.apply);
                }}
            />
        </div>
    );
}
