"use client";

/**
 * 概览 Tab：阶段推进/状态切换（均需用户二次确认）、阶段计划勾选、阶段建议编辑，
 * 以及文献/稿件计数。所有写操作都走 academicApi.updateProject 的 PATCH（按键合并），
 * 成功后由父组件静默刷新 detail 与项目摘要。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ListChecks, Loader2, RefreshCw, Save, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AutopilotCard } from "./autopilot-card";
import {
    academicApi,
    type AcademicAutoMode,
    type AcademicProjectDetail,
    type AcademicPlanTask,
    type AcademicResearchAdvice,
    type AcademicStage,
    type AcademicStageGateReport,
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


/**
 * 自动模式三选一：off 全手动、assist 只自动打勾计划任务、
 * auto 在门禁就绪时自动把当前阶段置为「待确认」并推进。approved 永远人工。
 */
const AUTO_MODE_OPTIONS: Array<{ value: AcademicAutoMode; label: string; hint: string }> = [
    { value: "off", label: "关闭", hint: "关闭自动化：计划任务与阶段推进都完全由你操作。" },
    {
        value: "assist",
        label: "建议",
        hint: "带自动规则的计划任务会随交付物自动打勾，但阶段不会自动推进。",
    },
    {
        value: "auto",
        label: "自动",
        hint: "门禁就绪时自动把当前阶段置为「待确认」并推进到下一阶段；approved 仍需你人工确认。",
    },
];

const AUTO_MODE_LABELS: Record<AcademicAutoMode, string> = { off: "关闭", assist: "建议", auto: "自动" };

interface PendingAction {
    title: string;
    message: string;
    confirmLabel: string;
    apply: () => Promise<void>;
}

export function OverviewTab({
    detail,
    onChanged,
    selectedStage,
    onSelectStage,
}: {
    detail: AcademicProjectDetail;
    onChanged: () => Promise<void>;
    /** 顶部阶段步骤条选中的阶段（受控）；缺省时使用当前阶段。 */
    selectedStage?: AcademicStage;
    onSelectStage?: (stage: AcademicStage) => void;
}) {
    const { project } = detail;
    const [internalStage, setInternalStage] = useState<AcademicStage>(project.stage);
    const stage = selectedStage ?? internalStage;
    const [adviceDraft, setAdviceDraft] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [advice, setAdvice] = useState<AcademicResearchAdvice | null>(null);
    const [adviceBusy, setAdviceBusy] = useState(false);
    const [adviceError, setAdviceError] = useState<string | null>(null);
    const [backupBusy, setBackupBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    // 自动模式与阶段门禁都是后端状态：本地只保存正在编辑/展示的副本。
    const [autoMode, setAutoMode] = useState<AcademicAutoMode>(project.autoMode ?? "off");
    const [gates, setGates] = useState<AcademicStageGateReport | null>(null);
    const [gatesError, setGatesError] = useState<string | null>(null);

    // 切换项目 / 当前阶段时，把建议草稿重置为后端保存的内容。
    useEffect(() => {
        setInternalStage(project.stage);
    }, [project.id, project.stage]);

    // 后端刷新（onChanged）后同步自动模式显示；静默刷新不应覆盖正在进行的写操作。
    useEffect(() => {
        setAutoMode(project.autoMode ?? "off");
    }, [project.id, project.autoMode]);

    // 门禁 checklist 只在切换项目时重新拉取；同步/写操作后的刷新由 run() 触发。
    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                const report = await academicApi.getProjectGates(project.id);
                if (active) {
                    setGates(report);
                    setGatesError(null);
                }
            } catch (e) {
                if (active) setGatesError(e instanceof Error ? e.message : "门禁状态加载失败");
            }
        })();
        return () => {
            active = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随项目切换重新拉取
    }, [project.id]);

    async function loadGates() {
        try {
            setGates(await academicApi.getProjectGates(project.id));
            setGatesError(null);
        } catch (e) {
            setGatesError(e instanceof Error ? e.message : "门禁状态加载失败");
        }
    }

    // 只在切换阶段/项目时载入草稿：静默刷新 detail 不应覆盖用户正在编辑的内容。
    useEffect(() => {
        setAdviceDraft(detail.advice[stage] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随阶段/项目重置
    }, [stage, project.id]);

    const loadAdvice = useCallback(async () => {
        setAdviceBusy(true);
        setAdviceError(null);
        try {
            setAdvice(await academicApi.getNextActions(project.id));
        } catch (e) {
            setAdviceError(e instanceof Error ? e.message : "加载下一步建议失败");
        } finally {
            setAdviceBusy(false);
        }
    }, [project.id]);

    useEffect(() => {
        /* eslint-disable-next-line react-hooks/set-state-in-effect -- initial advice fetch */
        void loadAdvice();
    }, [loadAdvice]);

    const downloadBackup = async () => {
        setBackupBusy(true);
        setError(null);
        try {
            const blob = await academicApi.downloadProjectBackup(project.id);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = project.title + "-备份.json";
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : "导出项目备份失败");
        } finally {
            setBackupBusy(false);
        }
    };

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
            // 写操作可能改变门禁/计划状态：刷新 checklist，失败不覆盖主错误。
            void loadGates();
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
    const autoModeHint = AUTO_MODE_OPTIONS.find((option) => option.value === autoMode)?.hint ?? "";

    async function changeAutoMode(mode: AcademicAutoMode) {
        if (mode === autoMode) return;
        await run("auto-mode-" + mode, async () => {
            await academicApi.updateProject(project.id, { autoMode: mode });
            setAutoMode(mode);
            setNotice("自动模式已切换为「" + AUTO_MODE_LABELS[mode] + "」");
        });
    }

    async function syncGates() {
        await run("gates-sync", async () => {
            const result = await academicApi.syncProjectGates(project.id);
            setGates({ stage: project.stage, report: result.report });
            const summary =
                result.sync.length === 0
                    ? "没有需要自动完成的计划任务"
                    : "自动完成 " + result.sync.length + " 个计划任务";
            const advance = result.advanced.advanced
                ? "已自动推进到「" + (result.advanced.to ? STAGE_LABELS[result.advanced.to] : "下一阶段") + "」"
                : "未自动推进：" + (result.advanced.reason ?? "条件未满足");
            setNotice("进度已同步：" + summary + "；" + advance);
        });
    }

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

                <p className="mt-3 border-t border-border-subtle pt-3 text-[11px] text-tertiary">
                    在上方阶段步骤条选择要查看计划/建议的阶段；阶段徽标显示该阶段自身状态。
                </p>

                {/* 自动模式 + 阶段门禁 checklist */}
                <div className="mt-3 border-t border-border-subtle pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] font-medium text-foreground">自动模式</span>
                            <div className="flex gap-1.5">
                                {AUTO_MODE_OPTIONS.map((option) => {
                                    const active = autoMode === option.value;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => void changeAutoMode(option.value)}
                                            disabled={busy !== null}
                                            className={cn(
                                                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
                                                active
                                                    ? "border-accent bg-accent-soft text-accent"
                                                    : "border-border bg-surface text-secondary hover:border-tertiary hover:text-foreground",
                                            )}
                                        >
                                            {busy === "auto-mode-" + option.value && (
                                                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                                            )}
                                            {option.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void syncGates()}
                            disabled={busy !== null}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                        >
                            {busy === "gates-sync" ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <RefreshCw className="h-3 w-3" />
                            )}
                            同步进度
                        </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-tertiary">{autoModeHint}</p>

                    {gatesError ? (
                        <p className="mt-2 rounded-lg bg-border-subtle/60 px-2.5 py-2 text-[11px] text-secondary">
                            门禁状态不可用：{gatesError}
                        </p>
                    ) : gates ? (
                        <ul className="mt-2 space-y-0.5">
                            {gates.report.map((entry) => {
                                const current = entry.stage === project.stage;
                                return (
                                    <li key={entry.stage} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
                                        <span
                                            className={cn(
                                                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                                                entry.ready ? "bg-success" : "bg-tertiary",
                                            )}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-1.5 text-[12px] leading-relaxed">
                                                <span className={cn("font-medium", current ? "text-foreground" : "text-secondary")}>
                                                    {STAGE_LABELS[entry.stage]}
                                                    {current && (
                                                        <span className="ml-1 text-[10px] font-normal text-tertiary">·当前</span>
                                                    )}
                                                </span>
                                                <span className={cn("text-[11px]", entry.ready ? "text-success" : "text-tertiary")}>
                                                    {entry.ready ? "已就绪" : "未就绪"} · {entry.doneCount}/{entry.taskCount}
                                                </span>
                                            </div>
                                            {!entry.ready && entry.missing.length > 0 && (
                                                <ul className="mt-0.5 space-y-0.5">
                                                    {entry.missing.map((item, index) => (
                                                        <li
                                                            key={index}
                                                            className="text-[11px] leading-relaxed text-tertiary"
                                                        >
                                                            · {item}
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="mt-2 text-[11px] text-tertiary">门禁状态加载中…</p>
                    )}
                    <p className="mt-1.5 text-[11px] text-tertiary">
                        自动模式只会把阶段置为「待确认」（submitted）；approved（已确认）永远需要你人工操作。
                    </p>
                </div>
            </SurfaceCard>

            {/* 下一步建议 */}
            <SurfaceCard>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Sparkles className="h-3.5 w-3.5" />
                        下一步建议
                    </h3>
                    <button
                        type="button"
                        onClick={() => void loadAdvice()}
                        disabled={adviceBusy}
                        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-border-subtle disabled:opacity-40"
                    >
                        {adviceBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        刷新
                    </button>
                </div>
                <p className="mt-1 text-[12px] text-secondary">
                    基于当前阶段门禁、文献/稿件/校验状态自动生成，不调用模型，不编造内容。
                </p>
                {adviceError && <ErrorBanner message={adviceError} onRetry={() => void loadAdvice()} />}
                {!adviceError && advice && advice.suggestions.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                        {advice.suggestions.map((item) => (
                            <li
                                key={item.id}
                                className="rounded-lg border border-border-subtle px-2.5 py-2"
                            >
                                <div className="flex items-start gap-2">
                                    <span
                                        className={cn(
                                            "mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                            item.severity === "blocker"
                                                ? "bg-danger/10 text-danger"
                                                : item.severity === "warning"
                                                  ? "bg-warning/10 text-warning"
                                                  : "bg-accent-soft text-accent",
                                        )}
                                    >
                                        {item.severity === "blocker" ? "阻塞" : item.severity === "warning" ? "建议" : "提示"}
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-[12px] font-medium text-foreground">{item.title}</p>
                                        <p className="mt-0.5 text-[11px] leading-relaxed text-secondary">{item.reason}</p>
                                        <p className="mt-1 break-words font-mono text-[11px] text-tertiary">{item.action}</p>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                {!adviceError && advice && advice.suggestions.length === 0 && (
                    <p className="mt-2 text-[12px] text-tertiary">暂无建议。</p>
                )}
            </SurfaceCard>

            <AutopilotCard projectId={project.id} />

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
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
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
                <SurfaceCard>
                    <div className="text-[11px] text-tertiary">项目备份</div>
                    <button
                        type="button"
                        disabled={backupBusy}
                        onClick={() => void downloadBackup()}
                        className="mt-2 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-foreground disabled:opacity-40"
                    >
                        {backupBusy ? "导出中…" : "导出 JSON"}
                    </button>
                    <p className="mt-1 text-[10px] text-tertiary">项目/文献/稿件/事件审计导出</p>
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
