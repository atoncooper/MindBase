"use client";

/**
 * ExecutionCard - 沙箱单条执行记录（状态/语言/耗时/退出码 + stdout/stderr
 * 预览 + 产物链接 + 取消按钮）。
 *
 * stdout/stderr 是 app-sandbox 落库的截断预览（默认 4KB）：折叠时只露几行，
 * 展开后在固定高度内滚动查看完整预览。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Paperclip, Square } from "lucide-react";
import type { SandboxArtifact, SandboxExecution, SandboxTimestamp } from "@/lib/api";
import { Pill, SurfaceCard } from "@/components/research/research-ui";
import { cn } from "@/lib/utils";

/** 状态中文文案；未知状态原样展示（后端新增状态时不至于空白）。 */
const STATUS_LABELS: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    timeout: "超时",
    canceled: "已取消",
};

/** 状态徽标配色（沿用 Apple 语义色）。 */
const STATUS_STYLES: Record<string, string> = {
    queued: "bg-border-subtle text-tertiary",
    running: "bg-accent-soft text-accent",
    succeeded: "bg-success/10 text-success",
    failed: "bg-danger/10 text-danger",
    timeout: "bg-warning/10 text-warning",
    canceled: "bg-border text-secondary",
};

function statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
}

function statusStyle(status: string): string {
    return STATUS_STYLES[status] ?? "bg-border-subtle text-secondary";
}

/** 时间戳归一化：兼容 RFC3339 字符串（Go time.Time）与毫秒数。 */
function toMillis(value?: SandboxTimestamp): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function formatDateTime(value?: SandboxTimestamp): string {
    const ms = toMillis(value);
    if (ms === undefined) return "—";
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms?: number): string {
    if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes} m ${rest} s`;
}

function formatBytes(bytes?: number): string {
    if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function OutputBlock({
    label,
    text,
    bytes,
    expanded,
    danger,
}: {
    label: string;
    text: string;
    bytes?: number;
    expanded: boolean;
    danger?: boolean;
}) {
    return (
        <div>
            <div className="flex items-center justify-between text-[11px] text-tertiary">
                <span className="font-mono">{label}</span>
                <span>{formatBytes(bytes)}</span>
            </div>
            <pre
                className={cn(
                    "mt-1 whitespace-pre-wrap break-words rounded-lg bg-border-subtle/60 px-3 py-2 font-mono text-[11.5px] leading-relaxed",
                    expanded ? "max-h-[360px] overflow-y-auto" : "max-h-16 overflow-y-hidden",
                    danger ? "text-danger" : "text-foreground",
                )}
            >
                {text}
            </pre>
        </div>
    );
}

function ArtifactChip({ artifact }: { artifact: SandboxArtifact }) {
    const label =
        artifact.size !== undefined && artifact.size !== null
            ? `${artifact.name}（${formatBytes(artifact.size)}）`
            : artifact.name;
    if (!artifact.url) {
        return (
            <span className="rounded-md bg-border-subtle px-2 py-0.5 text-secondary" title="暂无下载链接">
                {label}
            </span>
        );
    }
    return (
        <a
            href={artifact.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-border-subtle px-2 py-0.5 text-accent hover:underline"
            title="下载产物（短期有效链接）"
        >
            {label}
        </a>
    );
}

export interface ExecutionCardProps {
    execution: SandboxExecution;
    /** 该卡片是否正在提交取消请求。 */
    cancelling: boolean;
    onCancel: (executionId: string) => void;
}

export function ExecutionCard({ execution, cancelling, onCancel }: ExecutionCardProps) {
    const [expanded, setExpanded] = useState(false);
    const stdout = execution.stdoutPreview ?? "";
    const stderr = execution.stderrPreview ?? "";
    const hasOutput = stdout.length > 0 || stderr.length > 0;
    const artifacts = execution.artifacts ?? [];
    const done = execution.done;

    return (
        <SurfaceCard className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
                <span
                    className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                        statusStyle(execution.status),
                    )}
                >
                    {statusLabel(execution.status)}
                </span>
                <span className="font-mono text-[12px] font-medium text-foreground">{execution.language}</span>
                {execution.purpose ? <Pill>{execution.purpose}</Pill> : null}
                {execution.projectId ? <Pill>项目 {execution.projectId}</Pill> : null}
                <div className="ml-auto flex items-center gap-2">
                    {!done && (
                        <button
                            type="button"
                            onClick={() => onCancel(execution.executionId)}
                            disabled={cancelling}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Square className="h-2.5 w-2.5" />
                            {cancelling ? "取消中…" : "取消"}
                        </button>
                    )}
                    <span className="text-[11px] text-tertiary">{formatDateTime(execution.createdAt)}</span>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-secondary">
                <span>耗时 {formatDuration(execution.durationMs)}</span>
                {execution.exitCode !== undefined && execution.exitCode !== null ? (
                    <span>退出码 {execution.exitCode}</span>
                ) : null}
                {execution.timeoutMs > 0 && <span>超时上限 {formatDuration(execution.timeoutMs)}</span>}
                {execution.errorCode ? <span className="text-danger">错误码 {execution.errorCode}</span> : null}
                <span className="ml-auto font-mono text-tertiary">{execution.executionId}</span>
            </div>

            {hasOutput && (
                <div className="space-y-1.5">
                    {stdout && (
                        <OutputBlock label="stdout" text={stdout} bytes={execution.stdoutBytes} expanded={expanded} />
                    )}
                    {stderr && (
                        <OutputBlock
                            label="stderr"
                            text={stderr}
                            bytes={execution.stderrBytes}
                            expanded={expanded}
                            danger
                        />
                    )}
                    <button
                        type="button"
                        onClick={() => setExpanded((value) => !value)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                    >
                        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {expanded ? "收起输出" : "展开完整输出"}
                    </button>
                </div>
            )}

            {artifacts.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5 text-[11px]">
                    <span className="inline-flex items-center gap-1 text-tertiary">
                        <Paperclip className="h-3 w-3" />
                        产物
                    </span>
                    {artifacts.map((artifact, index) => (
                        <ArtifactChip key={`${artifact.name}-${index}`} artifact={artifact} />
                    ))}
                </div>
            )}
        </SurfaceCard>
    );
}
