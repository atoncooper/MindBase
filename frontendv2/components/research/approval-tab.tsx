"use client";

/**
 * 人工审批 Tab：AI 只能创建 pending 请求，用户在这里批准/拒绝实验或投稿。
 * 审批通过后 academic_experiment(submit) 才会真正启动。
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { academicApi, type AcademicApproval, type AcademicApprovalKind } from "@/lib/api";
import { EmptyState, ErrorBanner, LoadingBlock, formatDateTime } from "./research-ui";

const KIND_LABELS: Record<AcademicApprovalKind, string> = {
    experiment: "实验执行",
    submission: "论文提交",
};

const STATUS_LABELS: Record<string, string> = {
    pending: "待审批",
    approved: "已批准",
    rejected: "已拒绝",
};

export function ApprovalTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
    const [approvals, setApprovals] = useState<AcademicApproval[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setApprovals(await academicApi.listApprovals(projectId));
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载审批失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const decide = async (approval: AcademicApproval, approved: boolean) => {
        const note = approved ? "已批准" : window.prompt("拒绝原因（可选）") ?? "";
        setBusy(approval.id);
        try {
            await academicApi.decideApproval(approval.id, approved, note || undefined);
            await load();
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "审批失败");
        } finally {
            setBusy(null);
        }
    };

    const request = async (kind: AcademicApprovalKind) => {
        setBusy(kind);
        try {
            await academicApi.requestApproval(projectId, kind, "工作台手动发起");
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建审批失败");
        } finally {
            setBusy(null);
        }
    };

    if (loading) return <LoadingBlock label="加载审批…" />;

    return (
        <div className="space-y-4">
            {error && <ErrorBanner message={error} onRetry={() => void load()} />}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void request("experiment")}
                    className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
                >
                    申请实验审批
                </button>
                <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void request("submission")}
                    className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
                >
                    申请提交审批
                </button>
            </div>
            {approvals.length === 0 ? (
                <EmptyState
                    icon={ShieldCheck}
                    title="还没有审批"
                    description="智能体提交实验或论文前会在这里创建待审批记录。"
                />
            ) : (
                <ul className="space-y-2">
                    {approvals.map((approval) => (
                        <li key={approval.id} className="rounded-lg border border-border-subtle bg-surface p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <span className="text-[13px] font-medium text-foreground">
                                        {KIND_LABELS[approval.kind] ?? approval.kind}
                                    </span>
                                    <span className="ml-2 rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                        {STATUS_LABELS[approval.status] ?? approval.status}
                                    </span>
                                    <p className="mt-1 text-[11px] text-tertiary">
                                        {formatDateTime(approval.requestedAt)}
                                        {approval.note ? " · " + approval.note : ""}
                                    </p>
                                </div>
                                {approval.status === "pending" && (
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            disabled={busy === approval.id}
                                            onClick={() => void decide(approval, true)}
                                            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                                        >
                                            <Check className="h-3.5 w-3.5" /> 批准
                                        </button>
                                        <button
                                            type="button"
                                            disabled={busy === approval.id}
                                            onClick={() => void decide(approval, false)}
                                            className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-[12px] font-medium text-foreground disabled:opacity-50"
                                        >
                                            <X className="h-3.5 w-3.5" /> 拒绝
                                        </button>
                                    </div>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
