"use client";

/**
 * 计划 Tab：两个区块（互不依赖，各自加载/重试）。
 *
 * 1) 阶段执行计划（只读，顶部）：agent 用 academic_project(plan_set) 保存、或在概览 Tab
 *    手动编辑的阶段任务/建议，来自 GET /academic/projects/:projectId（detail.plans/advice）。
 *    此前只在概览 Tab 可见，用户容易误以为"生成计划没保存"。
 * 2) 计划运行（底部）：本项目最近的 DAG 计划运行，来自 GET /chat/plans?project_id=<projectId>
 *    （goal / status / 更新时间 / 节点进度）；run 的 projectId 由对话回合的
 *    academic_project_id（科研工作台上下文）自动打标；点击展开调用 GET /chat/plans/:runId
 *    渲染节点列表（标题 / 状态 / 输出 / 错误）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    academicApi,
    type AcademicPlanNodeStatus,
    type AcademicPlanNodeView,
    type AcademicPlanRunDetail,
    type AcademicPlanRunStatus,
    type AcademicPlanRunSummary,
    type AcademicProjectDetail,
} from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    Pill,
    STAGE_LABELS,
    STAGE_ORDER,
    formatDateTime,
} from "./research-ui";

const RUN_STATUS_LABELS: Record<AcademicPlanRunStatus, string> = {
    pending: "待执行",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    partial: "部分完成",
};

const RUN_STATUS_STYLES: Record<AcademicPlanRunStatus, string> = {
    pending: "bg-border-subtle text-secondary",
    running: "bg-accent-soft text-accent",
    completed: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    partial: "bg-warning/10 text-warning",
};

const NODE_STATUS_LABELS: Record<AcademicPlanNodeStatus, string> = {
    pending: "待开始",
    in_progress: "进行中",
    done: "已完成",
    failed: "失败",
    skipped: "已跳过",
};

const NODE_MARK: Record<AcademicPlanNodeStatus, string> = {
    pending: "·",
    in_progress: "▶",
    done: "✓",
    failed: "✗",
    skipped: "⊘",
};

const NODE_MARK_CLASS: Record<AcademicPlanNodeStatus, string> = {
    pending: "text-tertiary",
    in_progress: "text-accent",
    done: "text-success",
    failed: "text-danger",
    skipped: "text-tertiary",
};

const NODE_TITLE_CLASS: Record<AcademicPlanNodeStatus, string> = {
    pending: "text-secondary",
    in_progress: "text-foreground",
    done: "text-secondary",
    failed: "text-danger",
    skipped: "text-tertiary line-through",
};

function NodeRow({ node }: { node: AcademicPlanNodeView }) {
    const status = node.status;
    return (
        <li className="rounded-lg border border-border-subtle px-2.5 py-2">
            <div className="flex items-start gap-2">
                <span
                    className={cn(
                        "mt-px w-3 shrink-0 text-center text-[11px]",
                        NODE_MARK_CLASS[status] ?? "text-tertiary",
                    )}
                    aria-hidden="true"
                >
                    {NODE_MARK[status] ?? "·"}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                            className={cn(
                                "break-words text-[12px] font-medium",
                                NODE_TITLE_CLASS[status] ?? "text-secondary",
                            )}
                        >
                            {node.title}
                        </span>
                        <Pill>{NODE_STATUS_LABELS[status] ?? status}</Pill>
                        {node.agent && (
                            <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                {node.agent}
                            </span>
                        )}
                    </div>
                    {node.note && (
                        <p className="mt-0.5 break-words text-[11px] text-tertiary">{node.note}</p>
                    )}
                    {node.error && (
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-danger/5 p-2 font-mono text-[11px] leading-relaxed text-danger">
                            {node.error}
                        </pre>
                    )}
                    {node.output && (
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-border-subtle/50 p-2 font-mono text-[11px] leading-relaxed text-secondary">
                            {node.output}
                        </pre>
                    )}
                </div>
            </div>
        </li>
    );
}

export function PlansTab({ projectId }: { projectId: string }) {
    const [runs, setRuns] = useState<AcademicPlanRunSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, AcademicPlanRunDetail>>({});
    const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
    const [detailError, setDetailError] = useState<string | null>(null);

    // 阶段执行计划（agent plan_set / 概览 Tab 保存）：独立于 DAG 运行列表的
    // loading/error，projectId 变化时重新拉取。
    const [stagePlanDetail, setStagePlanDetail] = useState<AcademicProjectDetail | null>(null);
    const [stagePlanLoading, setStagePlanLoading] = useState(true);
    const [stagePlanError, setStagePlanError] = useState<string | null>(null);

    // 快速切换展开项时只接受最后一次详情请求的响应。
    const detailSeq = useRef(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.plans(30, undefined, projectId);
            setRuns(result.runs);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载计划历史失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        // 首屏拉取。load() 会同步 setLoading(true)，放到定时器里执行以避开
        // react-hooks/set-state-in-effect 的同步级联渲染（同 quiz/share-dialog）。
        const timer = window.setTimeout(() => void load(), 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    const loadStagePlans = useCallback(async () => {
        setStagePlanLoading(true);
        setStagePlanError(null);
        try {
            const detail = await academicApi.getProject(projectId);
            setStagePlanDetail(detail);
        } catch (e) {
            setStagePlanError(e instanceof Error ? e.message : "加载阶段执行计划失败");
        } finally {
            setStagePlanLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        // 同上：阶段执行计划的独立拉取同样延后到定时器。
        const timer = window.setTimeout(() => void loadStagePlans(), 0);
        return () => window.clearTimeout(timer);
    }, [loadStagePlans]);

    const loadDetail = useCallback(async (runId: string) => {
        const seq = detailSeq.current + 1;
        detailSeq.current = seq;
        setDetailError(null);
        setDetailLoadingId(runId);
        try {
            const detail = await academicApi.getPlanRun(runId);
            if (detailSeq.current === seq) {
                setDetails((current) => ({ ...current, [runId]: detail }));
            }
        } catch (e) {
            if (detailSeq.current === seq) {
                setDetailError(e instanceof Error ? e.message : "加载计划详情失败");
            }
        } finally {
            if (detailSeq.current === seq) setDetailLoadingId(null);
        }
    }, []);

    const toggleRun = (run: AcademicPlanRunSummary) => {
        if (expandedRunId === run.runId) {
            detailSeq.current += 1;
            setExpandedRunId(null);
            setDetailLoadingId(null);
            setDetailError(null);
            return;
        }
        setExpandedRunId(run.runId);
        setDetailError(null);
        if (!details[run.runId]) void loadDetail(run.runId);
    };

    return (
        <div className="space-y-5">
            {/* ---- 阶段执行计划（只读；agent plan_set / 概览 Tab 保存） ---- */}
            <section className="space-y-2.5" aria-label="阶段执行计划">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <ListChecks className="h-3.5 w-3.5" />
                        阶段执行计划
                    </h3>
                    <span className="text-[11px] text-tertiary">agent / 概览 Tab 保存 · 只读</span>
                </div>
                <p className="text-[12px] leading-relaxed text-secondary">
                    项目各阶段已保存的执行计划与阶段建议。需要勾选任务或编辑建议请到「概览」Tab；也可以在对话里让学术 agent 用 plan_set 生成，保存后会显示在这里。
                </p>
                {stagePlanLoading && <LoadingBlock label="加载阶段执行计划…" />}
                {!stagePlanLoading && stagePlanError && (
                    <ErrorBanner
                        message={stagePlanError}
                        onRetry={() => void loadStagePlans()}
                    />
                )}
                {!stagePlanLoading && !stagePlanError && stagePlanDetail && (
                    <StagePlansSection detail={stagePlanDetail} />
                )}
            </section>

            {/* ---- 计划运行（plan_and_run 的 DAG 执行记录） ---- */}
            <section className="space-y-3 border-t border-border-subtle pt-4" aria-label="计划运行">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Workflow className="h-3.5 w-3.5" />
                        计划运行
                    </h3>
                    <span className="text-[11px] text-tertiary">plan_and_run 的 DAG 执行记录</span>
                </div>
                <p className="text-[12px] leading-relaxed text-secondary">
                    这里是本项目最近的 DAG 任务计划：从本项目的对话（「在对话中继续」）里让智能体用 plan_and_run 拆解任务时，计划会自动归属当前科研项目。点击任意计划展开节点执行结果。
                </p>

                {loading ? (
                    <LoadingBlock label="加载计划历史…" />
                ) : error ? (
                    <ErrorBanner message={error} onRetry={() => void load()} />
                ) : runs.length === 0 ? (
                    <EmptyState
                        icon={Workflow}
                        title="本项目还没有计划运行"
                        description="从本项目的对话里让智能体拆解复杂任务（plan_and_run）后，计划执行记录会出现在这里；历史版本创建的旧计划没有项目标记，不会显示在本 Tab。"
                    />
                ) : (
                    <ul className="space-y-2">
                        {runs.map((run) => {
                            const expanded = expandedRunId === run.runId;
                            const detail = details[run.runId];
                            const counts = run.nodeCounts ?? {
                                total: 0,
                                done: 0,
                                failed: 0,
                                skipped: 0,
                                running: 0,
                                pending: 0,
                            };
                            const finished = counts.done + counts.skipped;
                            const ratio =
                                counts.total > 0
                                    ? Math.round((finished / counts.total) * 100)
                                    : 0;
                            return (
                                <li
                                    key={run.runId}
                                    className="rounded-lg border border-border-subtle bg-surface"
                                >
                                    <button
                                        type="button"
                                        onClick={() => void toggleRun(run)}
                                        aria-expanded={expanded}
                                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                                    >
                                        {expanded ? (
                                            <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
                                        ) : (
                                            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
                                        )}
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="break-words text-[13px] font-medium text-foreground">
                                                    {run.goal || "未命名计划"}
                                                </span>
                                                <Pill
                                                    className={cn(RUN_STATUS_STYLES[run.status])}
                                                >
                                                    {RUN_STATUS_LABELS[run.status] ?? run.status}
                                                </Pill>
                                            </span>
                                            <span className="mt-1 block text-[11px] text-tertiary">
                                                更新 {formatDateTime(run.updatedAt)}
                                                {` · 节点 ${finished}/${counts.total} 完成`}
                                                {counts.failed > 0 ? ` · ${counts.failed} 失败` : ""}
                                                {counts.running > 0 ? ` · ${counts.running} 运行中` : ""}
                                            </span>
                                            <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-border-subtle">
                                                <span
                                                    className="block h-full rounded-full bg-accent transition-[width] duration-300"
                                                    style={{ width: `${ratio}%` }}
                                                />
                                            </span>
                                        </span>
                                    </button>

                                    {expanded && (
                                        <div className="border-t border-border-subtle px-3 py-2.5">
                                            {detailError && !detail && (
                                                <ErrorBanner
                                                    message={detailError}
                                                    onRetry={() => void loadDetail(run.runId)}
                                                />
                                            )}
                                            {!detail && !detailError && detailLoadingId === run.runId && (
                                                <LoadingBlock label="加载计划详情…" />
                                            )}
                                            {detail && (
                                                <PlanDetail detail={detail} />
                                            )}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}

/** 渲染一个计划的节点列表；快照只有线性 steps 时按 steps 降级展示。 */
function PlanDetail({ detail }: { detail: AcademicPlanRunDetail }) {
    const plan = detail.plan;
    const nodes: AcademicPlanNodeView[] =
        plan?.nodes && plan.nodes.length > 0
            ? plan.nodes
            : (plan?.steps ?? []).map((step, index) => ({
                  id: `step-${index}`,
                  title: step.desc,
                  status: (step.status as AcademicPlanNodeStatus) || "pending",
                  ...(step.note ? { note: step.note } : {}),
              }));

    if (nodes.length === 0) {
        return <p className="text-[12px] text-tertiary">计划快照暂无节点。</p>;
    }

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
                <span>runId：{detail.runId}</span>
                <span>
                    快照版本：{plan?.version !== undefined ? `v${plan.version}` : "—"}
                </span>
                {plan?.goal && <span className="break-all">目标：{plan.goal}</span>}
            </div>
            <ul className="space-y-1.5">
                {nodes.map((node) => (
                    <NodeRow key={node.id} node={node} />
                ))}
            </ul>
        </div>
    );
}

/**
 * 只读渲染项目各阶段已保存的执行计划与阶段建议（agent plan_set / 概览 Tab 写入）。
 * 没有任何内容时给出去哪里生成/编辑的引导；编辑入口统一留在概览 Tab。
 */
function StagePlansSection({ detail }: { detail: AcademicProjectDetail }) {
    const stages = STAGE_ORDER.filter((stage) => {
        const tasks = detail.plans[stage] ?? [];
        const advice = detail.advice[stage];
        return tasks.length > 0 || !!advice?.trim();
    });

    if (stages.length === 0) {
        return (
            <EmptyState
                icon={ListChecks}
                title="还没有阶段执行计划"
                description="可以在「概览」Tab 手动编辑各阶段的任务计划与建议；也可以在对话里让学术 agent 用 plan_set 生成阶段执行计划，保存后会显示在这里。"
            />
        );
    }

    return (
        <div className="grid gap-3 md:grid-cols-2">
            {stages.map((stage) => {
                const tasks = detail.plans[stage] ?? [];
                const doneCount = tasks.filter((task) => task.done).length;
                const advice = detail.advice[stage]?.trim();
                return (
                    <section
                        key={stage}
                        className="rounded-xl border border-border-subtle bg-surface p-3.5"
                        aria-label={`${STAGE_LABELS[stage]}阶段执行计划`}
                    >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-[13px] font-semibold text-foreground">
                                {STAGE_LABELS[stage]}
                            </h4>
                            <Pill>
                                {doneCount}/{tasks.length} 完成
                            </Pill>
                        </div>

                        {tasks.length > 0 ? (
                            <ul className="mt-2 space-y-1">
                                {tasks.map((task) => (
                                    <li key={task.id} className="flex items-start gap-2">
                                        <span
                                            className={cn(
                                                "mt-px w-3 shrink-0 text-center text-[11px]",
                                                task.done ? "text-success" : "text-tertiary",
                                            )}
                                            aria-hidden="true"
                                        >
                                            {task.done ? "✓" : "○"}
                                        </span>
                                        <span className="min-w-0 flex-1 text-[12px] leading-relaxed">
                                            <span
                                                className={
                                                    task.done
                                                        ? "text-tertiary line-through"
                                                        : "text-foreground"
                                                }
                                            >
                                                {task.title}
                                            </span>
                                            {task.note && (
                                                <span className="ml-1 text-[11px] text-tertiary">
                                                    （{task.note}）
                                                </span>
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-2 text-[12px] text-secondary">
                                该阶段暂无任务计划，仅保存了阶段建议。
                            </p>
                        )}

                        {advice && (
                            <div className="mt-2.5 rounded-lg bg-border-subtle/60 px-2.5 py-2">
                                <div className="text-[11px] font-medium text-secondary">阶段建议</div>
                                <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-secondary">
                                    {advice}
                                </p>
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
