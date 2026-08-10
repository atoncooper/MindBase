"use client";

/**
 * Video list - the second level of the favorites drill-down.
 *
 * Paginated list of videos inside one folder. Each video expands to reveal
 * its 分P list (PageList) where per-page vectorization lives.
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Loader2, AlertCircle, Film, ImageOff } from "lucide-react";
import { favoritesV2Api, type FavoriteVideoV2 } from "@/lib/api/favorites";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelativeTime } from "./status-helpers";
import { PageList } from "./page-list";

interface VideoListProps {
    mediaId: number;
}

const PAGE_SIZE = 20;

export function VideoList({ mediaId }: VideoListProps) {
    const [videos, setVideos] = useState<FavoriteVideoV2[]>([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expandedBvid, setExpandedBvid] = useState<string | null>(null);

    const load = useCallback(
        async (targetPage: number, append: boolean) => {
            if (append) setLoadingMore(true);
            else setLoading(true);
            setError(null);
            try {
                const res = await favoritesV2Api.listVideos(mediaId, targetPage, PAGE_SIZE);
                setVideos((prev) => (append ? [...prev, ...res.videos] : res.videos));
                setPage(res.page);
                setHasMore(res.has_more);
                setTotal(res.total);
            } catch (e) {
                setError(e instanceof Error ? e.message : "加载视频失败");
            } finally {
                setLoading(false);
                setLoadingMore(false);
            }
        },
        [mediaId]
    );

    useEffect(() => {
        // Mount-time data fetch; suppress the cascading-render false positive.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load(1, false);
    }, [load]);

    const toggleExpand = (bvid: string) => {
        setExpandedBvid((prev) => (prev === bvid ? null : bvid));
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-secondary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                加载视频…
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-danger">
                <AlertCircle className="h-3.5 w-3.5" />
                {error}
                <button
                    type="button"
                    onClick={() => void load(1, false)}
                    className="ml-1 text-accent hover:underline"
                >
                    重试
                </button>
            </div>
        );
    }

    if (videos.length === 0) {
        return (
            <div className="px-4 py-4 text-center text-[12px] text-secondary">
                该收藏夹暂无视频
            </div>
        );
    }

    return (
        <div>
            <div className="flex items-center gap-2 px-4 pt-1 pb-2 text-[11px] text-secondary">
                <Film className="h-3 w-3" />
                <span>共 {total} 个视频</span>
            </div>
            <ul className="divide-y divide-border-subtle">
                {videos.map((video) => {
                    const isOpen = expandedBvid === video.bvid;
                    return (
                        <li key={`${video.bvid}-${video.id}`}>
                            <button
                                type="button"
                                onClick={() => toggleExpand(video.bvid)}
                                aria-expanded={isOpen}
                                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-border-subtle/60"
                            >
                                {/* Cover thumbnail */}
                                <div className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-border-subtle">
                                    {video.cover ? (
                                        // B站封面是外部资源，用原生 <img> 避免 next/image 远端配置
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={video.cover}
                                            alt=""
                                            loading="lazy"
                                            referrerPolicy="no-referrer"
                                            className="h-full w-full object-cover"
                                            onError={(e) => {
                                                (e.currentTarget as HTMLImageElement).style.display = "none";
                                            }}
                                        />
                                    ) : (
                                        <ImageOff className="h-3.5 w-3.5 text-tertiary" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] text-foreground/90">{video.title}</p>
                                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-secondary">
                                        {video.owner && <span className="truncate">{video.owner}</span>}
                                        <span>· {formatDuration(video.duration)}</span>
                                        {video.synced_at && (
                                            <span className="hidden sm:inline">
                                                · 同步于 {formatRelativeTime(video.synced_at)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <ChevronDown
                                    className={cn(
                                        "h-4 w-4 shrink-0 text-tertiary transition-transform duration-200",
                                        isOpen && "rotate-180"
                                    )}
                                />
                            </button>
                            <AnimatePresence initial={false}>
                                {isOpen && (
                                    <motion.div
                                        key="pages"
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.24, ease: [0.28, 0.11, 0.32, 1] }}
                                        className="overflow-hidden bg-background/40"
                                    >
                                        <PageList bvid={video.bvid} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </li>
                    );
                })}
            </ul>
            {hasMore && (
                <div className="flex justify-center py-3">
                    <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() => void load(page + 1, true)}
                        className="btn-pill btn-ghost h-7 px-4 text-[12px]"
                    >
                        {loadingMore ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            "加载更多"
                        )}
                    </button>
                </div>
            )}
        </div>
    );
}
