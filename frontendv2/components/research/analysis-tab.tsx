"use client";

/**
 * 分析 Tab：生成结果表（academic_analysis）。
 *
 * 后端把项目实验运行汇总成 Markdown 结果表，并尽力上传到学术空间
 * 04_结果/results_summary.md；这里渲染 Markdown 原文与上传位置信息。
 * 不引入 Markdown 依赖，用等宽 pre 保留表格排版。
 */
import { useState } from "react";
import { Loader2, Table2 } from "lucide-react";
import { academicApi, type AcademicAnalysisResult } from "@/lib/api";
import { EmptyState, ErrorBanner, LoadingBlock } from "./research-ui";

export function AnalysisTab({ projectId }: { projectId: string }) {
    const [result, setResult] = useState<AcademicAnalysisResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generate = async () => {
        setBusy(true);
        setError(null);
        try {
            setResult(await academicApi.generateResults(projectId));
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成结果表失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="max-w-[640px] text-[12px] leading-relaxed text-secondary">
                    把项目的实验运行汇总为结果表（Markdown），并尽力上传到学术空间
                    <span className="font-mono text-[11px] text-tertiary"> 04_结果/results_summary.md </span>
                    ；生成后可直接粘贴进论文「结果」章节。
                </p>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void generate()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                    {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Table2 className="h-3.5 w-3.5" />
                    )}
                    生成结果表
                </button>
            </div>

            {error && <ErrorBanner message={error} onRetry={() => void generate()} />}

            {busy && !result ? (
                <LoadingBlock label="生成结果表…" />
            ) : result === null ? (
                <EmptyState
                    icon={Table2}
                    title="还没有生成结果表"
                    description="点击「生成结果表」，后端会汇总已记录实验运行并返回 Markdown 结果表。"
                />
            ) : (
                <div className="space-y-3">
                    <div className="rounded-xl border border-border-subtle bg-surface p-4">
                        <p className="text-[12px] text-secondary">
                            {result.uploadUuid
                                ? "已上传到学术空间 04_结果/results_summary.md"
                                : "已生成结果表，但未能上传到云盘（云盘可能暂不可用）。"}
                        </p>
                        {result.uploadUuid && (
                            <p className="mt-1 break-all text-[11px] text-tertiary">
                                uploadUuid：
                                <span className="font-mono">{result.uploadUuid}</span>
                                {result.folderId !== undefined
                                    ? ` · folderId: ${result.folderId}`
                                    : ""}
                            </p>
                        )}
                    </div>

                    <div className="rounded-xl border border-border-subtle bg-surface">
                        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
                            <h3 className="text-[13px] font-medium text-foreground">结果表 Markdown</h3>
                            <span className="text-[11px] text-tertiary">
                                {result.markdown.length} 字符
                            </span>
                        </div>
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-secondary">
                            {result.markdown}
                        </pre>
                    </div>
                </div>
            )}
        </div>
    );
}
