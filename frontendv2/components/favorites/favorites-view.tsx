"use client";

/**
 * FavoritesView - top-level orchestrator for the favorites page.
 *
 * Loads folders + their indexing status, lets the user select folders and
 * kick off a knowledge build (ASR + vectorize), and exposes a sync action to
 * pull the latest folder list from B站. Drill-down (folder -> video -> page)
 * lives in the child components; this file owns the page-level state machine.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    RefreshCw,
    Loader2,
    AlertCircle,
    CloudDownload,
    Sparkles,
    X,
    Zap,
} from "lucide-react";
import { favoritesV2Api, type FavoriteFolderV2 } from "@/lib/api/favorites";
import { knowledgeApi, type BuildStatus, type FolderStatus } from "@/lib/api/knowledge";
import { cn } from "@/lib/utils";
import { FolderCard } from "./folder-card";
import { KgPanel } from "./kg-panel";

type LoadState = "loading" | "ready" | "error";

interface BuildRun {
    taskId: string;
    status: BuildStatus["status"];
    progress: number;
    currentStep: string;
    processed: number;
    total: number;
    message: string;
}

const BUILD_POLL_INTERVAL_MS = 2000;
const BUILD_POLL_MAX_ATTEMPTS = 150; // ~5 min ceiling

export function FavoritesView() {
    const [folders, setFolders] = useState<FavoriteFolderV2[]>([]);
    const [statusMap, setStatusMap] = useState<Record<number, FolderStatus>>({});
    const [loadState, setLoadState] = useState<LoadState>("loading");
    const [loadError, setLoadError] = useState<string>("");
    const [syncing, setSyncing] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [build, setBuild] = useState<BuildRun | null>(null);
    const [buildError, setBuildError] = useState<string | null>(null);
    const buildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const loadAll = useCallback(async () => {
        setLoadState("loading");
        setLoadError("");
        try {
            const [foldersRes, statusRes] = await Promise.allSettled([
                favoritesV2Api.listFolders(),
                knowledgeApi.getFolderStatus(),
            ]);
            if (foldersRes.status === "fulfilled") {
                setFolders(foldersRes.value);
            } else {
                throw foldersRes.reason;
            }
            if (statusRes.status === "fulfilled") {
                const map: Record<number, FolderStatus> = {};
                for (const s of statusRes.value) map[s.media_id] = s;
                setStatusMap(map);
            }
            setLoadState("ready");
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : "加载收藏夹失败");
            setLoadState("error");
        }
    }, []);

    const reloadStatuses = useCallback(async () => {
        try {
            const list = await knowledgeApi.getFolderStatus();
            const map: Record<number, FolderStatus> = {};
            for (const s of list) map[s.media_id] = s;
            setStatusMap(map);
        } catch {
            // Non-fatal: folder list still usable without fresh statuses.
        }
    }, []);

    useEffect(() => {
        // Mount-time data fetch (legitimate external-system sync, not derived
        // state). The lint rule can't tell the two apart, so suppress here.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadAll();
    }, [loadAll]);

    // Clean up any pending build poll on unmount.
    useEffect(() => {
        return () => {
            if (buildTimer.current) clearTimeout(buildTimer.current);
        };
    }, []);

    const handleSync = useCallback(async () => {
        setSyncing(true);
        try {
            await favoritesV2Api.syncFolders();
            await loadAll();
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : "同步收藏夹失败");
            setLoadState("error");
        } finally {
            setSyncing(false);
        }
    }, [loadAll]);

    const toggleSelect = useCallback((mediaId: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(mediaId)) next.delete(mediaId);
            else next.add(mediaId);
            return next;
        });
    }, []);

    const pollBuild = useCallback(
        async (taskId: string) => {
            let attempts = 0;
            const tick = async () => {
                attempts += 1;
                try {
                    const s = await knowledgeApi.getBuildStatus(taskId);
                    setBuild({
                        taskId,
                        status: s.status,
                        progress: s.progress,
                        currentStep: s.current_step,
                        processed: s.processed_videos,
                        total: s.total_videos,
                        message: s.message,
                    });
                    if (s.status === "done" || s.status === "completed") {
                        setBuild(null);
                        setSelectedIds(new Set());
                        setBuildError(null);
                        void reloadStatuses();
                        return;
                    }
                    if (s.status === "failed") {
                        setBuild(null);
                        setBuildError(s.message || "构建失败");
                        void reloadStatuses();
                        return;
                    }
                } catch {
                    // Transient network error - keep polling until ceiling.
                }
                if (attempts >= BUILD_POLL_MAX_ATTEMPTS) {
                    setBuild(null);
                    setBuildError("构建超时，请稍后在知识库页面查看结果");
                    return;
                }
                buildTimer.current = setTimeout(tick, BUILD_POLL_INTERVAL_MS);
            };
            void tick();
        },
        [reloadStatuses]
    );

    const handleBuild = useCallback(async () => {
        if (selectedIds.size === 0 || build) return;
        setBuildError(null);
        const folderIds = Array.from(selectedIds);
        setBuild({
            taskId: "",
            status: "pending",
            progress: 0,
            currentStep: "提交构建任务…",
            processed: 0,
            total: 0,
            message: "",
        });
        try {
            const res = await knowledgeApi.build({ folder_ids: folderIds });
            await pollBuild(res.task_id);
        } catch (e) {
            setBuild(null);
            setBuildError(e instanceof Error ? e.message : "发起构建失败");
        }
    }, [selectedIds, build, pollBuild]);

    const cancelBuildPoll = useCallback(() => {
        if (buildTimer.current) {
            clearTimeout(buildTimer.current);
            buildTimer.current = null;
        }
        setBuild(null);
    }, []);

    // ───────────────────────────────────────────────
    // Render: loading skeleton
    // ───────────────────────────────────────────────
    if (loadState === "loading") {
        return (
            <FavoritesShell>
                <Header syncing={false} onSync={() => {}} onRefresh={() => {}} refreshing={false} count={0} />
                <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-16 animate-pulse rounded-2xl bg-border-subtle" />
                    ))}
                </div>
            </FavoritesShell>
        );
    }

    // ───────────────────────────────────────────────
    // Render: error
    // ───────────────────────────────────────────────
    if (loadState === "error") {
        return (
            <FavoritesShell>
                <Header syncing={false} onSync={() => {}} onRefresh={() => void loadAll()} refreshing={false} count={0} />
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border-subtle py-16 text-center">
                    <AlertCircle className="h-7 w-7 text-danger" />
                    <p className="mt-3 text-[14px] text-foreground">{loadError}</p>
                    <button type="button" onClick={() => void loadAll()} className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]">
                        重试
                    </button>
                </div>
            </FavoritesShell>
        );
    }

    // ───────────────────────────────────────────────
    // Render: empty state (no folders yet)
    // ───────────────────────────────────────────────
    if (folders.length === 0) {
        return (
            <FavoritesShell>
                <Header syncing={syncing} onSync={() => void handleSync()} onRefresh={() => void loadAll()} refreshing={syncing} count={0} />
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border-subtle py-20 text-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-border-subtle text-secondary">
                        <CloudDownload className="h-5 w-5" />
                    </span>
                    <p className="mt-4 text-[15px] font-medium text-foreground">还没有收藏夹</p>
                    <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                        从 B站同步你的收藏夹后，即可在此浏览视频并构建知识库。
                    </p>
                    <button
                        type="button"
                        disabled={syncing}
                        onClick={() => void handleSync()}
                        className="btn-pill btn-primary mt-6 h-9 px-5 text-[13px]"
                    >
                        {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
                        同步 B站收藏夹
                    </button>
                </div>
            </FavoritesShell>
        );
    }

    // ───────────────────────────────────────────────
    // Render: ready
    // ───────────────────────────────────────────────
    const selectedCount = selectedIds.size;
    const building = build !== null;

    return (
        <FavoritesShell>
            <Header
                syncing={syncing}
                onSync={() => void handleSync()}
                onRefresh={() => void reloadStatuses()}
                refreshing={syncing}
                count={folders.length}
            />

            {buildError && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/5 px-3.5 py-2.5 text-[12px] text-danger">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">{buildError}</span>
                    <button type="button" onClick={() => setBuildError(null)} className="text-danger/70 hover:text-danger">
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            <div className="space-y-3">
                {folders.map((folder) => (
                    <FolderCard
                        key={folder.media_id}
                        folder={folder}
                        status={statusMap[folder.media_id]}
                        selected={selectedIds.has(folder.media_id)}
                        onToggleSelect={toggleSelect}
                    />
                ))}
            </div>

            {/* Knowledge graph panel (Plan 1.0.5) - build scope follows folder selection */}
            <KgPanel selectedFolderIds={Array.from(selectedIds)} />

            {/* Build bar - sticky bottom, slides up when there's a selection or active build */}
            <AnimatePresence>
                {(selectedCount > 0 || building) && (
                    <motion.div
                        initial={{ y: 80, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 80, opacity: 0 }}
                        transition={{ duration: 0.28, ease: [0.28, 0.11, 0.32, 1] }}
                        className="sticky bottom-4 z-30 mt-6"
                    >
                        <div className="mx-auto max-w-[640px] rounded-2xl border border-border bg-surface/90 p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.10)] backdrop-blur-xl">
                            {building && build ? (
                                <BuildProgress build={build} onCancel={cancelBuildPoll} />
                            ) : (
                                <div className="flex items-center gap-3">
                                    <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-accent">
                                        <Sparkles className="h-4 w-4" />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium text-foreground">
                                            已选 {selectedCount} 个收藏夹
                                        </p>
                                        <p className="text-[11px] text-secondary">
                                            将提取音频转写并写入向量库
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedIds(new Set())}
                                        className="btn-pill btn-ghost h-8 px-3 text-[12px]"
                                    >
                                        清除
                                    </button>
                                    <button
                                        type="button"
                                        disabled={building}
                                        onClick={() => void handleBuild()}
                                        className="btn-pill btn-primary h-8 px-4 text-[12px]"
                                    >
                                        <Zap className="h-3.5 w-3.5" />
                                        构建知识库
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </FavoritesShell>
    );
}

// ══════════════════════════════════════════════════════════════
// Sub-components
// ══════════════════════════════════════════════════════════════

function FavoritesShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="mx-auto max-w-[860px] px-5 py-8 pb-24">{children}</div>
    );
}

interface HeaderProps {
    syncing: boolean;
    onSync: () => void;
    onRefresh: () => void;
    refreshing: boolean;
    count: number;
}

function Header({ syncing, onSync, onRefresh, refreshing, count }: HeaderProps) {
    return (
        <div className="mb-6 flex items-end justify-between">
            <div>
                <h1 className="text-[26px] font-semibold tracking-tight text-foreground">收藏夹</h1>
                <p className="mt-0.5 text-[13px] text-secondary">
                    {count > 0 ? `共 ${count} 个收藏夹 · 选择后可构建知识库` : "管理你的 B站收藏并构建知识库"}
                </p>
            </div>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled={syncing}
                    onClick={onRefresh}
                    title="刷新状态"
                    className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
                >
                    <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
                </button>
                <button
                    type="button"
                    disabled={syncing}
                    onClick={onSync}
                    className="btn-pill btn-ghost h-8 px-3.5 text-[12px] disabled:opacity-50"
                >
                    {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
                    同步
                </button>
            </div>
        </div>
    );
}

function BuildProgress({ build, onCancel }: { build: BuildRun; onCancel: () => void }) {
    const pct = Math.max(0, Math.min(100, build.progress));
    const isFailed = build.status === "failed";
    return (
        <div>
            <div className="flex items-center gap-2.5">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                        {build.currentStep || "构建中…"}
                    </p>
                    <p className="text-[11px] text-secondary">
                        {build.total > 0
                            ? `已处理 ${build.processed}/${build.total} 个视频`
                            : "正在准备任务…"}
                    </p>
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
                        "h-full rounded-full transition-[width] duration-500 ease-out",
                        isFailed ? "bg-danger" : "bg-accent"
                    )}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}
