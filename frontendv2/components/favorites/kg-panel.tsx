"use client";

/**
 * KgPanel - 知识图谱面板（收藏夹页）。
 *
 * 图谱统计（实体/关系/证据/覆盖视频/待抽取分P）+ 构建入口 + 进度轮询。
 * 设计：plan/1.0.5-KnowledgeGraph/frontend-design.md；后端契约 /knowledge/kg/*。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Network, X } from "lucide-react";
import { kgApi, type KgStats } from "@/lib/api";
import { cn } from "@/lib/utils";

const KG_POLL_INTERVAL_MS = 2000;
const KG_POLL_MAX_ATTEMPTS = 300; // ~10 min ceiling（KG 抽取慢于向量构建）
const RESULT_CLEAR_MS = 6000;

type LoadState = "loading" | "ready" | "error";

interface BuildRun {
    taskId: string;
    status: string;
    progress: number;
    currentStep: string;
}

interface KgResult {
    total?: number;
    ok?: number;
    failed?: number;
    message?: string;
}

export function KgPanel({ selectedFolderIds }: { selectedFolderIds: number[] }) {
    const [stats, setStats] = useState<KgStats | null>(null);
    const [loadState, setLoadState] = useState<LoadState>("loading");
    const [build, setBuild] = useState<BuildRun | null>(null);
    const [resultMsg, setResultMsg] = useState<string>("");
    const [error, setError] = useState<string>("");
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const refreshStats = useCallback(async () => {
        try {
            setStats(await kgApi.getStats());
        } catch {
            // 统计刷新失败不致命，保留旧值
        }
    }, []);

    const stopPoll = useCallback(() => {
        if (pollTimer.current) {
            clearTimeout(pollTimer.current);
            pollTimer.current = null;
        }
    }, []);

    const pollBuild = useCallback(
        (taskId: string) => {
            let attempts = 0;
            const tick = async () => {
                attempts += 1;
                try {
                    const s = await kgApi.getStatus(taskId);
                    setBuild({
                        taskId,
                        status: s.status,
                        progress: s.progress,
                        currentStep: s.current_step,
                    });
                    if (s.status === "done" || s.status === "completed") {
                        setBuild(null);
                        stopPoll();
                        const r = (s.result ?? {}) as KgResult;
                        setResultMsg(
                            r.message ??
                                `已抽取 ${r.ok ?? 0} 个分P${r.failed ? `，失败 ${r.failed}` : ""}`,
                        );
                        // 结果摘要停留一段时间后自动收起
                        if (resultTimer.current) clearTimeout(resultTimer.current);
                        resultTimer.current = setTimeout(() => setResultMsg(""), RESULT_CLEAR_MS);
                        void refreshStats();
                        return;
                    }
                    if (s.status === "failed") {
                        setBuild(null);
                        stopPoll();
                        setError(s.error || "知识图谱构建失败");
                        void refreshStats();
                        return;
                    }
                } catch {
                    // 瞬时网络错误 - 继续轮询直到上限
                }
                if (attempts >= KG_POLL_MAX_ATTEMPTS) {
                    setBuild(null);
                    stopPoll();
                    setError("跟踪超时，请稍后刷新查看结果");
                    return;
                }
                pollTimer.current = setTimeout(tick, KG_POLL_INTERVAL_MS);
            };
            void tick();
        },
        [refreshStats, stopPoll]
    );

    const init = useCallback(async () => {
        setLoadState("loading");
        setError("");
        try {
            const [statsRes, activeRes] = await Promise.allSettled([
                kgApi.getStats(),
                kgApi.getActiveTask(),
            ]);
            if (statsRes.status === "rejected") throw statsRes.reason;
            setStats(statsRes.value);
            setLoadState("ready");
            if (
                statsRes.value.available &&
                activeRes.status === "fulfilled" &&
                activeRes.value.task_id
            ) {
                // 刷新页面后恢复对活跃任务的跟踪
                const taskId = activeRes.value.task_id;
                setBuild({ taskId, status: "pending", progress: 0, currentStep: "" });
                pollBuild(taskId);
            }
        } catch {
            setLoadState("error");
        }
    }, [pollBuild]);

    useEffect(() => {
        // Mount-time data fetch (external-system sync, not derived state).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void init();
        const pollTimerRef = pollTimer;
        const resultTimerRef = resultTimer;
        return () => {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        };
    }, [init]);

    const handleBuild = useCallback(async () => {
        if (build) return;
        setError("");
        setResultMsg("");
        if (resultTimer.current) clearTimeout(resultTimer.current);
        setBuild({ taskId: "", status: "pending", progress: 0, currentStep: "提交构建任务…" });
        try {
            const res = await kgApi.build(selectedFolderIds);
            setBuild({ taskId: res.task_id, status: "pending", progress: 0, currentStep: "" });
            pollBuild(res.task_id);
        } catch (e) {
            setBuild(null);
            setError(e instanceof Error ? e.message : "发起知识图谱构建失败");
        }
    }, [build, selectedFolderIds, pollBuild]);

    const cancelTracking = useCallback(() => {
        stopPoll();
        setBuild(null);
    }, [stopPoll]);

    // ───────────────────────────────────────────────
    // Render
    // ───────────────────────────────────────────────
    if (loadState === "loading") {
        return (
            <section className="mt-8">
                <div className="h-28 animate-pulse rounded-2xl bg-border-subtle" />
            </section>
        );
    }

    if (loadState === "error") {
        return (
            <section className="mt-8">
                <div className="flex flex-col items-center rounded-2xl border border-border-subtle py-8 text-center">
                    <AlertCircle className="h-5 w-5 text-danger" />
                    <p className="mt-2 text-[13px] text-secondary">知识图谱状态加载失败</p>
                    <button type="button" onClick={() => void init()} className="btn-pill btn-ghost mt-3 h-8 px-4 text-[12px]">
                        重试
                    </button>
                </div>
            </section>
        );
    }

    const available = stats?.available ?? false;
    const graph = stats?.graph;
    const building = build !== null;
    const scopeNote =
        selectedFolderIds.length > 0
            ? `作用域：所选 ${selectedFolderIds.length} 个收藏夹`
            : "作用域：全部收藏夹";

    return (
        <section className="mt-8">
            <div className="rounded-2xl border border-border-subtle bg-surface p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-soft text-accent">
                            <Network className="h-4 w-4" />
                        </span>
                        <div>
                            <h2 className="text-[15px] font-semibold text-foreground">知识图谱</h2>
                            <p className="mt-0.5 text-[12px] text-secondary">
                                从视频文字稿抽取实体与关系，问答时可检索实体关联
                            </p>
                        </div>
                    </div>
                    {!available && (
                        <span className="shrink-0 rounded-full bg-border-subtle px-2.5 py-1 text-[11px] text-secondary">
                            Neo4j 未连接
                        </span>
                    )}
                </div>

                {error && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/5 px-3.5 py-2.5 text-[12px] text-danger">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">{error}</span>
                        <button
                            type="button"
                            onClick={() => setError("")}
                            className="text-danger/70 hover:text-danger"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}

                {resultMsg && !building && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-success/20 bg-success/5 px-3.5 py-2.5 text-[12px] text-success">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">{resultMsg}</span>
                        <button
                            type="button"
                            onClick={() => {
                                if (resultTimer.current) clearTimeout(resultTimer.current);
                                setResultMsg("");
                            }}
                            className="text-success/70 hover:text-success"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}

                {building && build ? (
                    <KgProgress build={build} onCancel={cancelTracking} />
                ) : available && graph ? (
                    <>
                        <div className="mt-4 grid grid-cols-4 gap-3">
                            <StatCell label="实体" value={graph.entities} />
                            <StatCell label="关系" value={graph.relations} />
                            <StatCell label="证据" value={graph.evidence} />
                            <StatCell label="视频" value={graph.videos} />
                        </div>
                        {(stats?.pending_pages ?? 0) > 0 && (
                            <p className="mt-3 text-[11px] text-secondary">
                                {stats?.pending_pages} 个分P 待抽取 / 需更新
                            </p>
                        )}
                        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                            <p className="truncate text-[11px] text-secondary">{scopeNote}</p>
                            <button
                                type="button"
                                disabled={!available}
                                onClick={() => void handleBuild()}
                                className="btn-pill btn-primary h-8 shrink-0 px-4 text-[12px] disabled:opacity-50"
                            >
                                <Network className="h-3.5 w-3.5" />
                                构建知识图谱
                            </button>
                        </div>
                    </>
                ) : (
                    <p className="mt-4 text-[12px] text-secondary">
                        知识图谱存储不可用（Neo4j 未连接），无法构建或查询。
                    </p>
                )}
            </div>
        </section>
    );
}

// ══════════════════════════════════════════════════════════════
// Sub-components
// ══════════════════════════════════════════════════════════════

function StatCell({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl bg-surface-elevated px-3 py-2.5 text-center">
            <p className="text-[18px] font-semibold tabular-nums leading-tight text-foreground">
                {value.toLocaleString()}
            </p>
            <p className="mt-0.5 text-[11px] text-secondary">{label}</p>
        </div>
    );
}

function KgProgress({ build, onCancel }: { build: BuildRun; onCancel: () => void }) {
    const pct = Math.max(0, Math.min(100, build.progress));
    return (
        <div className="mt-4">
            <div className="flex items-center gap-2.5">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                        {build.currentStep || "知识图谱构建中…"}
                    </p>
                    <p className="text-[11px] text-secondary">正在抽取实体与关系</p>
                </div>
                <span className="text-[12px] font-medium tabular-nums text-secondary">{pct}%</span>
                <button
                    type="button"
                    onClick={onCancel}
                    className="grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    title="不再跟踪"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
                <div
                    className={cn(
                        "h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                    )}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}
