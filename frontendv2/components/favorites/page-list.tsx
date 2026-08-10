"use client";

/**
 * Page list - the third level of the favorites drill-down.
 *
 * Loads the 分P (parts) of one video and shows each part's vector status
 * with an inline vectorize / revector action. Vectorize is idempotent on the
 * backend; we poll the task until done/failed and reflect the result locally.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Zap, RotateCw, AlertCircle, Film } from "lucide-react";
import { favoritesV2Api, type VideoPageItemV2 } from "@/lib/api/favorites";
import { vecPageApi, type VectorPageTaskStatus } from "@/lib/api/vec-page";
import { cn } from "@/lib/utils";
import {
    VectorStatusDot,
    VectorStatusDotOnly,
    type VectorState,
} from "./status-helpers";

interface PageListProps {
    bvid: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 80; // ~2 min ceiling, ASR/vectorize can be slow

export function PageList({ bvid }: PageListProps) {
    const [pages, setPages] = useState<VideoPageItemV2[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Per-cid override state (optimistic + polled result), takes precedence
    // over the initially loaded is_vectorized string.
    const [overrides, setOverrides] = useState<Record<number, VectorState>>({});
    const [busyCids, setBusyCids] = useState<Set<number>>(new Set());
    const [pageErrors, setPageErrors] = useState<Record<number, string>>({});
    const pollTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

    const loadPages = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await favoritesV2Api.listVideoPages(bvid);
            setPages(res.pages);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载分P失败");
        } finally {
            setLoading(false);
        }
    }, [bvid]);

    useEffect(() => {
        void loadPages();
        // Clear any pending poll timers on unmount.
        return () => {
            Object.values(pollTimers.current).forEach(clearTimeout);
            pollTimers.current = {};
        };
    }, [loadPages]);

    const stateFor = (page: VideoPageItemV2): VectorState =>
        overrides[page.cid] ?? (page.is_vectorized as VectorState);

    const pollTask = useCallback(
        async (cid: number, taskId: string) => {
            let attempts = 0;
            const tick = async () => {
                attempts += 1;
                try {
                    const status: VectorPageTaskStatus = await vecPageApi.getTaskStatus(taskId);
                    if (status.status === "done") {
                        setOverrides((prev) => ({ ...prev, [cid]: "done" }));
                        setBusyCids((prev) => {
                            const next = new Set(prev);
                            next.delete(cid);
                            return next;
                        });
                        // Refresh to pick up chunk count + confirm.
                        void loadPages();
                        return;
                    }
                    if (status.status === "failed") {
                        setOverrides((prev) => ({ ...prev, [cid]: "failed" }));
                        setPageErrors((prev) => ({
                            ...prev,
                            [cid]: status.error || status.message || "向量化失败",
                        }));
                        setBusyCids((prev) => {
                            const next = new Set(prev);
                            next.delete(cid);
                            return next;
                        });
                        return;
                    }
                } catch {
                    // Network blip - keep polling until ceiling.
                }
                if (attempts >= POLL_MAX_ATTEMPTS) {
                    setOverrides((prev) => ({ ...prev, [cid]: "failed" }));
                    setPageErrors((prev) => ({ ...prev, [cid]: "向量化超时" }));
                    setBusyCids((prev) => {
                        const next = new Set(prev);
                        next.delete(cid);
                        return next;
                    });
                    return;
                }
                pollTimers.current[cid] = setTimeout(tick, POLL_INTERVAL_MS);
            };
            void tick();
        },
        [loadPages]
    );

    const vectorizePage = useCallback(
        async (page: VideoPageItemV2, force: boolean) => {
            setPageErrors((prev) => {
                const next = { ...prev };
                delete next[page.cid];
                return next;
            });
            setBusyCids((prev) => new Set(prev).add(page.cid));
            setOverrides((prev) => ({ ...prev, [page.cid]: "processing" }));
            try {
                const res = force
                    ? await vecPageApi.revector({ bvid, cid: page.cid })
                    : await vecPageApi.create({
                          bvid,
                          cid: page.cid,
                          page_index: page.page_index,
                          page_title: page.page_title ?? undefined,
                      });
                if (!res.task_id) {
                    // Idempotent no-op: already vectorized.
                    setOverrides((prev) => ({ ...prev, [page.cid]: "done" }));
                    setBusyCids((prev) => {
                        const next = new Set(prev);
                        next.delete(page.cid);
                        return next;
                    });
                    void loadPages();
                    return;
                }
                void pollTask(page.cid, res.task_id);
            } catch (e) {
                setOverrides((prev) => ({ ...prev, [page.cid]: "failed" }));
                setPageErrors((prev) => ({
                    ...prev,
                    [page.cid]: e instanceof Error ? e.message : "发起向量化失败",
                }));
                setBusyCids((prev) => {
                    const next = new Set(prev);
                    next.delete(page.cid);
                    return next;
                });
            }
        },
        [bvid, loadPages, pollTask]
    );

    if (loading) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-secondary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                加载分P…
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-danger">
                <AlertCircle className="h-3.5 w-3.5" />
                {error}
            </div>
        );
    }

    if (pages.length === 0) {
        return (
            <div className="px-4 py-3 text-[12px] text-secondary">
                该视频暂无分P信息
            </div>
        );
    }

    const doneCount = pages.filter((p) => stateFor(p) === "done").length;

    return (
        <div>
            <div className="flex items-center gap-2 px-4 pt-1 pb-2 text-[11px] text-secondary">
                <Film className="h-3 w-3" />
                <span>
                    {pages.length} 个分P · {doneCount} 已向量化
                </span>
            </div>
            <ul className="divide-y divide-border-subtle">
                {pages.map((page) => {
                    const state = stateFor(page);
                    const busy = busyCids.has(page.cid);
                    const title = page.page_title?.trim() || `第 ${page.page_index} P`;
                    return (
                        <li
                            key={page.cid}
                            className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-border-subtle/60"
                        >
                            <VectorStatusDotOnly state={state} />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] text-foreground/90">{title}</p>
                                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-secondary">
                                    <VectorStatusDot state={state} />
                                    {page.vector_chunk_count > 0 && (
                                        <span>· {page.vector_chunk_count} 块</span>
                                    )}
                                </div>
                                {pageErrors[page.cid] && (
                                    <p className="mt-0.5 text-[11px] text-danger">
                                        {pageErrors[page.cid]}
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                disabled={busy || state === "processing"}
                                onClick={() => void vectorizePage(page, state === "done")}
                                className={cn(
                                    "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors",
                                    state === "done"
                                        ? "text-secondary hover:bg-border-subtle hover:text-foreground"
                                        : "text-accent hover:bg-accent-soft",
                                    (busy || state === "processing") && "opacity-60"
                                )}
                            >
                                {busy || state === "processing" ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : state === "done" ? (
                                    <RotateCw className="h-3 w-3" />
                                ) : (
                                    <Zap className="h-3 w-3" />
                                )}
                                {state === "done" ? "重建" : state === "processing" ? "处理中" : "向量化"}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
