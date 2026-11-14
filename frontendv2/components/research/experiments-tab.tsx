"use client";

/**
 * 实验 Tab：项目实验执行记录（academic_experiment）。
 *
 * 列表展示状态 / 语言 / 退出码与时间；展开可看实验代码与 stdout/stderr/error；
 * queued / running 可取消（成功后刷新列表，并通过 onChanged 让外层刷新项目详情）。
 */
import { useCallback, useEffect, useState } from "react";
import {
    ChevronDown,
    ChevronRight,
    FlaskConical,
    Loader2,
    XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    academicApi,
    type AcademicExperiment,
    type AcademicExperimentStatus,
} from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    Pill,
    formatDateTime,
} from "./research-ui";

const STATUS_LABELS: Record<AcademicExperimentStatus, string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    interrupted: "已中断",
    cancelled: "已取消",
};

const STATUS_STYLES: Record<AcademicExperimentStatus, string> = {
    queued: "bg-border-subtle text-secondary",
    running: "bg-accent-soft text-accent",
    succeeded: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    interrupted: "bg-warning/10 text-warning",
    cancelled: "bg-border text-tertiary",
};

/** queued / running 之外都是终态，不再提供取消入口。 */
function isCancellable(status: AcademicExperimentStatus): boolean {
    return status === "queued" || status === "running";
}

function OutputBlock({ label, text }: { label: string; text?: string }) {
    if (!text) return null;
    return (
        <div className="mt-2">
            <p className="text-[11px] font-medium text-tertiary">{label}</p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-border-subtle/50 p-2 font-mono text-[11px] leading-relaxed text-secondary">
                {text}
            </pre>
        </div>
    );
}

export function ExperimentsTab({
    projectId,
    onChanged,
}: {
    projectId: string;
    onChanged?: () => void;
}) {
    const [experiments, setExperiments] = useState<AcademicExperiment[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.experiments(projectId, 50);
            setExperiments(result.experiments);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载实验记录失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const cancel = async (experiment: AcademicExperiment) => {
        setBusyId(experiment.id);
        setError(null);
        try {
            await academicApi.cancelExperiment(experiment.id);
            await load();
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : "取消实验失败");
        } finally {
            setBusyId(null);
        }
    };

    if (loading) return <LoadingBlock label="加载实验记录…" />;

    return (
        <div className="space-y-4">
            <p className="text-[12px] leading-relaxed text-secondary">
                实验由学术智能体在沙箱中执行：提交后进入排队 / 运行，结束后保留退出码与输出预览。
            </p>

            {error && <ErrorBanner message={error} onRetry={() => void load()} />}

            {experiments.length === 0 ? (
                <EmptyState
                    icon={FlaskConical}
                    title="还没有实验记录"
                    description="让学术智能体执行实验，或在对话里调用 academic_experiment 提交一次运行。"
                />
            ) : (
                <ul className="space-y-2">
                    {experiments.map((experiment) => {
                        const expanded = expandedId === experiment.id;
                        const busy = busyId === experiment.id;
                        const title = experiment.title?.trim() || `实验 ${experiment.id.slice(0, 8)}`;
                        return (
                            <li
                                key={experiment.id}
                                className="rounded-lg border border-border-subtle bg-surface"
                            >
                                <div className="flex items-start gap-2 p-3">
                                    <button
                                        type="button"
                                        onClick={() => setExpandedId(expanded ? null : experiment.id)}
                                        aria-expanded={expanded}
                                        className="min-w-0 flex-1 text-left"
                                    >
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            {expanded ? (
                                                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                                            ) : (
                                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                                            )}
                                            <span className="text-[13px] font-medium text-foreground">
                                                {title}
                                            </span>
                                            <Pill className={cn(STATUS_STYLES[experiment.status])}>
                                                {STATUS_LABELS[experiment.status] ?? experiment.status}
                                            </Pill>
                                            <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                                {experiment.language}
                                            </span>
                                            {experiment.exitCode !== undefined && (
                                                <span
                                                    className={cn(
                                                        "text-[11px]",
                                                        experiment.exitCode === 0
                                                            ? "text-success"
                                                            : "text-danger",
                                                    )}
                                                >
                                                    exit {experiment.exitCode}
                                                </span>
                                            )}
                                        </span>
                                        <span className="mt-1 block text-[11px] text-tertiary">
                                            创建 {formatDateTime(experiment.createdAt)}
                                            {experiment.startedAt
                                                ? ` · 开始 ${formatDateTime(experiment.startedAt)}`
                                                : ""}
                                            {experiment.endedAt
                                                ? ` · 结束 ${formatDateTime(experiment.endedAt)}`
                                                : ""}
                                            {` · 超时上限 ${Math.round(experiment.timeoutMs / 1000)}s`}
                                        </span>
                                    </button>

                                    {isCancellable(experiment.status) && (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => void cancel(experiment)}
                                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/5 disabled:opacity-50"
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <XCircle className="h-3 w-3" />
                                            )}
                                            取消
                                        </button>
                                    )}
                                </div>

                                {expanded && (
                                    <div className="border-t border-border-subtle px-3 py-2.5">
                                        {experiment.error && (
                                            <div className="rounded-lg border-l-2 border-danger bg-danger/5 px-2.5 py-2 text-[11px] text-danger">
                                                {experiment.error}
                                            </div>
                                        )}
                                        <OutputBlock label="stdout 预览" text={experiment.stdoutPreview} />
                                        <OutputBlock label="stderr 预览" text={experiment.stderrPreview} />
                                        {experiment.code && (
                                            <div className="mt-2">
                                                <p className="text-[11px] font-medium text-tertiary">
                                                    实验代码
                                                </p>
                                                <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-border-subtle/50 p-2 font-mono text-[11px] leading-relaxed text-secondary">
                                                    {experiment.code}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
