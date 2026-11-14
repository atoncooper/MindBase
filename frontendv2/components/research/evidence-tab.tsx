"use client";

/**
 * 证据 Tab：项目数据集（输入）与已记录运行（输出证据）两个区块。
 *
 * 运行记录可展开查看脚本 sha256、产物 artifacts 与 stdout/stderr 预览，
 * 让「结果可复现」在 UI 上可核对。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Database, FileClock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    academicApi,
    type AcademicDataset,
    type AcademicEvidenceFile,
    type AcademicRun,
    type AcademicRunStatus,
} from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    Pill,
    SurfaceCard,
    formatDateTime,
} from "./research-ui";

const RUN_STATUS_LABELS: Record<AcademicRunStatus, string> = {
    succeeded: "成功",
    failed: "失败",
    timed_out: "超时",
    recorded: "已记录",
};

const RUN_STATUS_STYLES: Record<AcademicRunStatus, string> = {
    succeeded: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    timed_out: "bg-warning/10 text-warning",
    recorded: "bg-border-subtle text-secondary",
};

/** 文件大小（数据集/产物只展示元数据）。 */
function formatBytes(bytes?: number): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function FileMeta({ file }: { file: AcademicEvidenceFile }) {
    return (
        <span className="break-all text-[11px] text-tertiary">
            {file.name}
            {` · ${formatBytes(file.sizeBytes)}`}
            {file.sha256 ? ` · sha256 ${file.sha256.slice(0, 12)}…` : ""}
        </span>
    );
}

function PreviewBlock({ label, text }: { label: string; text?: string }) {
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

export function EvidenceTab({ projectId }: { projectId: string }) {
    const [datasets, setDatasets] = useState<AcademicDataset[]>([]);
    const [runs, setRuns] = useState<AcademicRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.evidence(projectId, { limit: 50, offset: 0 });
            setDatasets(result.datasets);
            setRuns(result.runs);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载证据失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (loading) return <LoadingBlock label="加载证据…" />;

    const empty = datasets.length === 0 && runs.length === 0;

    return (
        <div className="space-y-4">
            <p className="text-[12px] leading-relaxed text-secondary">
                证据 = 实验输入（数据集）+ 实验输出（运行记录）。运行记录保存脚本指纹与产物元数据，用于结果可复现性核对。
            </p>

            {error && <ErrorBanner message={error} onRetry={() => void load()} />}

            {empty ? (
                <EmptyState
                    icon={Database}
                    title="还没有证据记录"
                    description="让学术智能体登记数据集或记录一次实验运行后，这里会显示输入与产物。"
                />
            ) : (
                <>
                    <SurfaceCard>
                        <div className="flex items-center justify-between">
                            <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                                <Database className="h-3.5 w-3.5 text-tertiary" />
                                数据集
                            </h3>
                            <span className="text-[11px] text-tertiary">{datasets.length} 个</span>
                        </div>
                        {datasets.length === 0 ? (
                            <p className="mt-3 text-[12px] text-tertiary">暂无数据集。</p>
                        ) : (
                            <ul className="mt-2.5 space-y-2">
                                {datasets.map((dataset) => (
                                    <li
                                        key={dataset.id}
                                        className="rounded-lg border border-border-subtle px-3 py-2"
                                    >
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="text-[12px] font-medium text-foreground">
                                                {dataset.name}
                                            </span>
                                            <Pill>{dataset.source}</Pill>
                                            <span className="text-[11px] text-tertiary">
                                                {formatDateTime(dataset.createdAt)}
                                            </span>
                                        </div>
                                        {dataset.description && (
                                            <p className="mt-1 break-words text-[11px] text-secondary">
                                                {dataset.description}
                                            </p>
                                        )}
                                        {dataset.files.length > 0 && (
                                            <ul className="mt-1.5 space-y-0.5">
                                                {dataset.files.map((file) => (
                                                    <li key={`${dataset.id}-${file.name}`}>
                                                        <FileMeta file={file} />
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </SurfaceCard>

                    <SurfaceCard>
                        <div className="flex items-center justify-between">
                            <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                                <FileClock className="h-3.5 w-3.5 text-tertiary" />
                                运行记录
                            </h3>
                            <span className="text-[11px] text-tertiary">{runs.length} 条</span>
                        </div>
                        {runs.length === 0 ? (
                            <p className="mt-3 text-[12px] text-tertiary">暂无运行记录。</p>
                        ) : (
                            <ul className="mt-2.5 space-y-2">
                                {runs.map((run) => {
                                    const expanded = expandedRunId === run.id;
                                    return (
                                        <li
                                            key={run.id}
                                            className="rounded-lg border border-border-subtle"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => setExpandedRunId(expanded ? null : run.id)}
                                                aria-expanded={expanded}
                                                className="flex w-full items-start gap-2 px-3 py-2 text-left"
                                            >
                                                {expanded ? (
                                                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
                                                ) : (
                                                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tertiary" />
                                                )}
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                        <span className="text-[12px] font-medium text-foreground">
                                                            {run.name}
                                                        </span>
                                                        <Pill
                                                            className={cn(
                                                                RUN_STATUS_STYLES[run.status],
                                                            )}
                                                        >
                                                            {RUN_STATUS_LABELS[run.status] ?? run.status}
                                                        </Pill>
                                                        <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                                            {run.language}
                                                        </span>
                                                        {run.exitCode !== undefined && (
                                                            <span className="text-[11px] text-tertiary">
                                                                exit {run.exitCode}
                                                            </span>
                                                        )}
                                                    </span>
                                                    <span className="mt-0.5 block text-[11px] text-tertiary">
                                                        {formatDateTime(run.createdAt)}
                                                        {run.artifacts.length > 0
                                                            ? ` · ${run.artifacts.length} 个产物`
                                                            : ""}
                                                    </span>
                                                </span>
                                            </button>

                                            {expanded && (
                                                <div className="border-t border-border-subtle px-3 py-2.5">
                                                    <p className="break-all text-[11px] text-tertiary">
                                                        scriptSha256：
                                                        <span className="font-mono text-secondary">
                                                            {run.scriptSha256 ?? "未记录"}
                                                        </span>
                                                    </p>
                                                    {run.executionId && (
                                                        <p className="mt-1 break-all text-[11px] text-tertiary">
                                                            executionId：
                                                            <span className="font-mono text-secondary">
                                                                {run.executionId}
                                                            </span>
                                                        </p>
                                                    )}
                                                    <div className="mt-2">
                                                        <p className="text-[11px] font-medium text-tertiary">
                                                            产物 artifacts
                                                        </p>
                                                        {run.artifacts.length === 0 ? (
                                                            <p className="mt-0.5 text-[11px] text-tertiary">
                                                                无产物。
                                                            </p>
                                                        ) : (
                                                            <ul className="mt-0.5 space-y-0.5">
                                                                {run.artifacts.map((artifact) => (
                                                                    <li key={`${run.id}-${artifact.name}`}>
                                                                        <FileMeta file={artifact} />
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                    </div>
                                                    <PreviewBlock
                                                        label="stdout 预览"
                                                        text={run.stdoutPreview}
                                                    />
                                                    <PreviewBlock
                                                        label="stderr 预览"
                                                        text={run.stderrPreview}
                                                    />
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </SurfaceCard>
                </>
            )}
        </div>
    );
}
