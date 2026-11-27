"use client";

/**
 * Progressive MP4/WebM video player with seamless presigned-URL recovery.
 *
 * The media bytes never traverse app-cloud: the browser talks to OpenResty,
 * which proxies/caches MinIO. app-cloud is only used to mint a new presigned
 * URL after the previous one expires (default 1h) or when playback errors.
 *
 * On expiry we do NOT reload the page or reset the video element. We capture
 * currentTime/volume/muted/playbackRate, fetch a fresh /raw response, point
 * the same <video> at the new URL, then restore the position and resume.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { cloudApi } from "@/lib/api/cloud";
import { toSameOriginUrl } from "./media-url";
import { VideoControls } from "./video-controls";

interface Props {
    uuid: string;
    initialUrl: string;
    /** Presigned URL lifetime from GET /cloud/video/:uuid/raw. */
    expiresIn?: number;
    onUrlChange?: (url: string) => void;
    /** Fill the parent's full width/height (full-screen cloud-drive viewer). */
    fill?: boolean;
}

interface ResumeState {
    time: number;
    paused: boolean;
    volume: number;
    muted: boolean;
    playbackRate: number;
}

type PlayerState = "loading" | "ready" | "error";

export function CloudVideoPlayer({ uuid, initialUrl, expiresIn = 3600, onUrlChange, fill = false }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [src, setSrc] = useState(initialUrl);
    const [state, setState] = useState<PlayerState>("loading");
    const [message, setMessage] = useState("");

    const resumeRef = useRef<ResumeState | null>(null);
    const prefetchedUrl = useRef<string | null>(null);
    const refreshing = useRef(false);
    const retries = useRef(0);

    const applyUrl = useCallback(
        (url: string) => {
            setSrc(url);
            onUrlChange?.(url);
        },
        [onUrlChange]
    );

    const refresh = useCallback(
        async (fromError: boolean) => {
            if (refreshing.current) return;
            refreshing.current = true;

            const video = videoRef.current;
            if (video) {
                resumeRef.current = {
                    time: video.currentTime || 0,
                    paused: video.paused,
                    volume: video.volume,
                    muted: video.muted,
                    playbackRate: video.playbackRate || 1,
                };
            }

            try {
                // A proactive prefetch may already hold a fresh URL; consume it
                // before asking app-cloud again.
                if (fromError && prefetchedUrl.current) {
                    const next = prefetchedUrl.current;
                    prefetchedUrl.current = null;
                    setState("loading");
                    applyUrl(next);
                    return;
                }

                const raw = await cloudApi.getRawFile(uuid);
                setState("loading");
                applyUrl(toSameOriginUrl(raw.url));
            } catch (e) {
                setMessage(e instanceof Error ? e.message : "视频地址刷新失败");
                setState("error");
            } finally {
                refreshing.current = false;
            }
        },
        [applyUrl, uuid]
    );

    // Prefetch a fresh URL shortly before the signature expires. We do not
    // swap src yet: the current playback continues until a Range request
    // actually fails, at which point the prefetched URL is used immediately.
    useEffect(() => {
        if (!uuid || expiresIn <= 180) return;
        const delay = Math.max(30_000, (expiresIn - 120) * 1000);
        const timer = window.setTimeout(() => {
            void cloudApi
                .getRawFile(uuid)
                .then((raw) => {
                    prefetchedUrl.current = toSameOriginUrl(raw.url);
                })
                .catch(() => {
                    /* best effort; error path will refresh synchronously */
                });
        }, delay);
        return () => window.clearTimeout(timer);
    }, [uuid, expiresIn]);

    const handleError = useCallback(() => {
        if (retries.current >= 3) {
            setMessage("视频加载失败，请重试");
            setState("error");
            return;
        }
        retries.current += 1;
        void refresh(true);
    }, [refresh]);

    const handleLoadedMetadata = useCallback(() => {
        const video = videoRef.current;
        const resume = resumeRef.current;
        if (!video || !resume) return;
        try {
            const duration = Number.isFinite(video.duration) ? video.duration : resume.time;
            video.currentTime = Math.min(Math.max(0, resume.time), Math.max(0, duration - 0.05));
            video.volume = resume.volume;
            video.muted = resume.muted;
            video.playbackRate = resume.playbackRate;
            if (!resume.paused) {
                void video.play().catch(() => {
                    /* browser may require a user gesture after source swap */
                });
            }
        } catch {
            /* ignore seek/restore failures; playback still works */
        }
        resumeRef.current = null;
        setState("ready");
    }, []);

    const retryNow = useCallback(() => {
        retries.current = 0;
        prefetchedUrl.current = null;
        setMessage("");
        setState("loading");
        void refresh(false);
    }, [refresh]);

    return (
        <div
            ref={containerRef}
            className={`group relative w-full overflow-hidden bg-black ${
                fill
                    ? "h-full"
                    : "mx-auto max-w-full rounded-2xl shadow-[0_20px_60px_-24px_rgba(0,0,0,0.55)] ring-1 ring-black/10"
            }`}
        >
            <video
                ref={videoRef}
                src={src}
                playsInline
                preload="metadata"
                className={
                    fill
                        ? "block h-full w-full bg-black object-contain"
                        : "mx-auto block max-h-[75dvh] w-full bg-black object-contain"
                }
                onLoadedMetadata={handleLoadedMetadata}
                onCanPlay={() => setState("ready")}
                onPlaying={() => setState("ready")}
                onWaiting={() => setState("loading")}
                onError={handleError}
            />

            <VideoControls
                videoRef={videoRef}
                containerRef={containerRef}
                disabled={state === "error"}
            />

            {state === "loading" && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/20">
                    <Loader2 className="h-6 w-6 animate-spin text-white/80" />
                </div>
            )}

            {state === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center text-white">
                    <AlertCircle className="h-7 w-7 text-red-400" />
                    <p className="text-[13px]">{message || "视频加载失败"}</p>
                    <button
                        type="button"
                        onClick={retryNow}
                        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-white/25"
                    >
                        <RotateCcw className="h-4 w-4" />
                        重试
                    </button>
                </div>
            )}
        </div>
    );
}
