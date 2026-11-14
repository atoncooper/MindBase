"use client";

/**
 * 校验 Tab：项目稿件只读一致性检查（academic_validation）。
 *
 * 检查引用是否齐全/已核验、记录运行是否可复现、结果章节是否带证据引用；
 * 只读无副作用，可反复运行。documentId 缺省 = 校验项目全部稿件。
 */
import { useState } from "react";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { academicApi, type AcademicValidationReport } from "@/lib/api";
import { EmptyState, ErrorBanner, Pill, SurfaceCard } from "./research-ui";

function RefList({
    label,
    items,
    emptyText,
}: {
    label: string;
    items: string[];
    emptyText: string;
}) {
    return (
        <div className="mt-2">
            <p className="text-[11px] font-medium text-tertiary">{label}</p>
            {items.length === 0 ? (
                <p className="mt-0.5 text-[11px] text-tertiary">{emptyText}</p>
            ) : (
                <ul className="mt-1 space-y-1">
                    {items.map((item) => (
                        <li
                            key={item}
                            className="break-all rounded bg-danger/5 px-2 py-1 font-mono text-[11px] text-danger"
                        >
                            {item}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function ValidationTab({ projectId }: { projectId: string }) {
    const [report, setReport] = useState<AcademicValidationReport | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await academicApi.validateProject(projectId);
            setReport(result.report);
        } catch (e) {
            setError(e instanceof Error ? e.message : "校验失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="max-w-[640px] text-[12px] leading-relaxed text-secondary">
                    校验会检查稿件引用是否缺失或未核验、记录实验运行是否可复现、结果章节是否带证据引用。
                    只读检查、不改动任何数据，可随时重复运行。
                </p>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                    {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <ClipboardCheck className="h-3.5 w-3.5" />
                    )}
                    运行校验
                </button>
            </div>

            {error && <ErrorBanner message={error} onRetry={() => void run()} />}

            {report === null ? (
                <EmptyState
                    icon={ClipboardCheck}
                    title="尚未运行校验"
                    description="点击「运行校验」后，这里会显示引用、运行可复现性与结果证据引用的检查结果。"
                />
            ) : (
                <>
                    <SurfaceCard>
                        <div className="flex flex-wrap items-center gap-2">
                            <Pill
                                className={cn(
                                    report.pass
                                        ? "bg-success/10 text-success"
                                        : "bg-danger/10 text-danger",
                                )}
                            >
                                {report.pass ? "校验通过" : "校验未通过"}
                            </Pill>
                            <span className="text-[12px] text-secondary">
                                {report.pass
                                    ? "所有检查项均通过。"
                                    : "存在需要处理的问题，详见下方分类。"}
                            </span>
                        </div>
                    </SurfaceCard>

                    <div className="grid gap-3 md:grid-cols-3">
                        <SurfaceCard>
                            <h3 className="text-[13px] font-medium text-foreground">引用</h3>
                            <p className="mt-1 text-[11px] text-tertiary">
                                共 {report.citations.total} 条引用
                            </p>
                            <RefList
                                label="缺失引用"
                                items={report.citations.missing}
                                emptyText="没有缺失引用。"
                            />
                            <RefList
                                label="未核验引用"
                                items={report.citations.unverified}
                                emptyText="没有未核验引用。"
                            />
                        </SurfaceCard>

                        <SurfaceCard>
                            <h3 className="text-[13px] font-medium text-foreground">实验运行</h3>
                            <p className="mt-1 text-[11px] text-tertiary">
                                共 {report.runs.total} 条记录运行
                            </p>
                            <RefList
                                label="不可复现运行"
                                items={report.runs.unreproducible}
                                emptyText="记录运行均可复现。"
                            />
                        </SurfaceCard>

                        <SurfaceCard>
                            <h3 className="text-[13px] font-medium text-foreground">结果章节</h3>
                            <p className="mt-1 text-[11px] text-tertiary">
                                共 {report.results.sections.length} 个结果章节
                            </p>
                            <RefList
                                label="缺证据引用"
                                items={report.results.withoutEvidenceRef}
                                emptyText="所有结果章节都带证据引用。"
                            />
                        </SurfaceCard>
                    </div>
                </>
            )}
        </div>
    );
}
