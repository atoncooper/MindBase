"use client";

/**
 * Semantic search results - 语义检索结果卡片。
 *
 * 每张卡片展示文件名、命中片段、相似度；点击就地打开该文件的详情。
 * 加载 / 空态 / 错误（如语义服务暂不可用）各自独立呈现，文件名字符串搜索不受影响。
 */
import { AlertCircle, Loader2, RefreshCw, SearchX } from "lucide-react";
import { formatBytes, type SemanticHit } from "@/lib/api/cloud";
import { FileIconTile } from "./file-icon";
import { formatSimilarity } from "./helpers";

interface SemanticResultsProps {
    hits: SemanticHit[];
    loading: boolean;
    error: string | null;
    /** 检索范围是否限定在当前文件夹 */
    onlyFolder: boolean;
    onRetry: () => void;
    onOpen: (uuid: string) => void;
}

export function SemanticResults({
    hits,
    loading,
    error,
    onlyFolder,
    onRetry,
    onOpen,
}: SemanticResultsProps) {
    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-[12px] text-tertiary">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                正在语义检索…
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-warning/10 text-warning">
                    <AlertCircle className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="mt-3 max-w-sm text-[13px] font-medium text-foreground">
                    语义检索暂不可用
                </p>
                <p className="mt-1 max-w-sm break-words text-[11.5px] text-secondary">{error}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="btn-pill btn-ghost mt-4 h-9 px-4 text-[12px]"
                >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    重试
                </button>
            </div>
        );
    }

    if (hits.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-border-subtle text-secondary">
                    <SearchX className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="mt-3 text-[13px] font-medium text-foreground">没有语义相关的文件</p>
                <p className="mt-1 max-w-xs text-[11.5px] text-secondary">
                    换个问法，或切换为文件名搜索试试。
                </p>
            </div>
        );
    }

    return (
        <div className="px-4 py-4">
            <p className="mb-2 px-1 text-[11.5px] text-tertiary">
                语义检索 · {hits.length} 个结果
                {onlyFolder ? "（仅当前文件夹）" : ""}
            </p>
            <ul className="space-y-2">
                {hits.map((hit) => {
                    const name = hit.title || hit.originalName;
                    return (
                        <li key={hit.uploadUuid}>
                            <button
                                type="button"
                                onClick={() => onOpen(hit.uploadUuid)}
                                className="flex w-full items-start gap-3 rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-border-subtle/30"
                            >
                                <FileIconTile mimeType={hit.mimeType} size="md" />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-baseline gap-2">
                                        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                                            {name}
                                        </span>
                                        <span
                                            className="shrink-0 text-[10.5px] tabular-nums text-accent"
                                            title="相似度"
                                        >
                                            {formatSimilarity(hit.score)}
                                        </span>
                                    </span>
                                    <span className="mt-0.5 block truncate text-[10.5px] text-tertiary">
                                        {hit.title && hit.title !== hit.originalName
                                            ? `${hit.originalName} · `
                                            : ""}
                                        {formatBytes(hit.fileSize)}
                                    </span>
                                    {(hit.snippets ?? []).slice(0, 2).map((snippet, i) => (
                                        <span
                                            key={i}
                                            className="mt-1.5 block line-clamp-2 text-[11.5px] leading-relaxed text-secondary"
                                        >
                                            {snippet}
                                        </span>
                                    ))}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
